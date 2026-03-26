const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "12345";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// זיכרון זמני לניהול שיחה לפי טלפון
const sessions = new Map();
// מניעת עיבוד כפול של אותה הודעה
const processedMessages = new Set();

app.get("/", (req, res) => {
  res.status(200).send("Bamakor webhook server is live");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("Webhook verify request:", { mode, token, challenge });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  console.log("Webhook verification failed");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // מחזירים 200 מהר כדי למנוע retry מיותר מ-Meta
  res.sendStatus(200);

  try {
    console.log("Incoming webhook body:", JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value) {
      console.log("No value in webhook");
      return;
    }

    if (!value.messages || !Array.isArray(value.messages) || value.messages.length === 0) {
      console.log("Webhook event is not a message");
      return;
    }

    const message = value.messages[0];
    const messageId = message.id;
    const from = message.from;
    const messageType = message.type;

    if (!messageId || !from) {
      console.log("Missing messageId / from");
      return;
    }

    if (processedMessages.has(messageId)) {
      console.log("Duplicate message ignored:", messageId);
      return;
    }

    processedMessages.add(messageId);
    setTimeout(() => processedMessages.delete(messageId), 10 * 60 * 1000);

    console.log("Incoming user message:", { from, messageType });

    const replyText = await handleConversation(from, message, value);
    console.log("Reply text:", replyText);

    if (!replyText) {
      console.log("No reply generated");
      return;
    }

    await sendWhatsAppMessage(from, replyText);
    console.log("Reply sent successfully");
  } catch (error) {
    console.error("Webhook error:", error);
  }
});

async function handleConversation(phone, message, value) {
  let session = sessions.get(phone);
  const messageType = message.type;
  const text = (message.text?.body || "").trim();

  // התחלת שיחה - בחירת שפה
  if (!session) {
    session = {
      lang: null,
      step: "choose_language",
      street: "",
      building: "",
      apartment: "",
      issue: "",
      ticketId: "",
      imageUrl: "",
      updatedAt: Date.now()
    };

    sessions.set(phone, session);
    return getLanguageSelectionText();
  }

  session.updatedAt = Date.now();

  // בחירת שפה
  if (session.step === "choose_language") {
    if (messageType !== "text") {
      return getLanguageSelectionInvalidText();
    }

    if (text === "1") {
      session.lang = "he";
      session.step = "waiting_street";
      return getText(session.lang, "ask_street");
    }

    if (text === "2") {
      session.lang = "en";
      session.step = "waiting_street";
      return getText(session.lang, "ask_street");
    }

    return getLanguageSelectionInvalidText();
  }

  if (session.step === "waiting_street") {
    if (messageType !== "text") {
      return getText(session.lang, "street_text_only");
    }

    session.street = text;
    session.step = "waiting_building";
    return getText(session.lang, "ask_building");
  }

  if (session.step === "waiting_building") {
    if (messageType !== "text") {
      return getText(session.lang, "building_text_only");
    }

    session.building = text;
    session.step = "waiting_apartment";
    return getText(session.lang, "ask_apartment");
  }

  if (session.step === "waiting_apartment") {
    if (messageType !== "text") {
      return getText(session.lang, "apartment_text_only");
    }

    session.apartment = text;
    session.step = "waiting_issue";
    return getText(session.lang, "ask_issue");
  }

  if (session.step === "waiting_issue") {
    if (messageType !== "text") {
      return getText(session.lang, "issue_text_only");
    }

    session.issue = text;
    session.ticketId = generateTicketId();
    session.step = "waiting_optional_image";

    return buildPreSummaryMessage(
      session.lang,
      session.ticketId,
      session.street,
      session.building,
      session.apartment,
      session.issue
    );
  }

  if (session.step === "waiting_optional_image") {
    // אם שלח תמונה
    if (messageType === "image") {
      const imageId = message.image?.id || "";
      session.imageUrl = imageId ? `whatsapp-media-id:${imageId}` : "";
    }

    // אם שלח טקסט "דלג" / "skip" או שלח כל טקסט אחר - פשוט נמשיך
    await writeTicketToSheet({
      ticketId: session.ticketId,
      phone,
      lang: session.lang,
      street: session.street,
      building: session.building,
      apartment: session.apartment,
      issue: session.issue,
      imageUrl: session.imageUrl || ""
    });

    const summary = buildFinalSummaryMessage(
      session.lang,
      session.ticketId,
      session.street,
      session.building,
      session.apartment,
      session.issue,
      session.imageUrl
    );

    // סוגרים session אוטומטית - אין תלות ב-0/1
    sessions.delete(phone);
    return summary;
  }

  sessions.delete(phone);
  return getLanguageSelectionText();
}

async function writeTicketToSheet(data) {
  if (!APPS_SCRIPT_URL) {
    throw new Error("Missing APPS_SCRIPT_URL env variable");
  }

  console.log("Sending ticket to Apps Script:", data);

  const response = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });

  const rawText = await response.text();
  console.log("Apps Script raw response:", rawText);

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error("Apps Script response is not valid JSON");
  }

  if (!parsed.ok) {
    throw new Error(`Apps Script error: ${parsed.error || "unknown error"}`);
  }
}

async function sendWhatsAppMessage(to, messageText) {
  if (!WHATSAPP_TOKEN) {
    throw new Error("Missing WHATSAPP_TOKEN env variable");
  }

  if (!PHONE_NUMBER_ID) {
    throw new Error("Missing PHONE_NUMBER_ID env variable");
  }

  const response = await fetch(
    `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        text: {
          body: messageText
        }
      })
    }
  );

  const rawText = await response.text();
  console.log("WhatsApp API response:", rawText);

  if (!response.ok) {
    throw new Error(`WhatsApp API error: ${rawText}`);
  }
}

function generateTicketId() {
  const random = Math.floor(100000 + Math.random() * 900000);
  return `BMK-${random}`;
}

function getLanguageSelectionText() {
  return (
    "ברוכים הבאים למוקד התקלות של Bamakor 🛠️\n" +
    "Welcome to Bamakor maintenance desk 🛠️\n\n" +
    "לבחירת שפה / Choose language:\n" +
    "1 - עברית\n" +
    "2 - English"
  );
}

function getLanguageSelectionInvalidText() {
  return (
    "בחירה לא תקינה.\n" +
    "Invalid choice.\n\n" +
    "לבחירת שפה / Choose language:\n" +
    "1 - עברית\n" +
    "2 - English"
  );
}

function getText(lang, key) {
  const texts = {
    he: {
      ask_street:
        "שלום וברוכים הבאים למוקד התקלות של Bamakor.\n\nנא לציין את שם הרחוב.",
      ask_building:
        "תודה. נא לציין את מספר הבניין.",
      ask_apartment:
        "מעולה. נא לציין את מספר הדירה.",
      ask_issue:
        "אנא פרט בקצרה מהי התקלה.",
      street_text_only:
        "נא לרשום את שם הרחוב בטקסט בלבד.",
      building_text_only:
        "נא לרשום את מספר הבניין בטקסט בלבד.",
      apartment_text_only:
        "נא לרשום את מספר הדירה בטקסט בלבד.",
      issue_text_only:
        "נא לפרט את התקלה בטקסט בלבד.",
      ask_optional_image:
        "אם תרצה, אפשר לשלוח עכשיו צילום של התקלה.\nאם אין צילום, אפשר לכתוב 'דלג'."
    },
    en: {
      ask_street:
        "Hello and welcome to the Bamakor maintenance desk.\n\nPlease enter the street name.",
      ask_building:
        "Thank you. Please enter the building number.",
      ask_apartment:
        "Great. Please enter the apartment number.",
      ask_issue:
        "Please briefly describe the issue.",
      street_text_only:
        "Please enter the street name as text only.",
      building_text_only:
        "Please enter the building number as text only.",
      apartment_text_only:
        "Please enter the apartment number as text only.",
      issue_text_only:
        "Please describe the issue as text only.",
      ask_optional_image:
        "If you want, you can now send a photo of the issue.\nIf not, type 'skip'."
    }
  };

  return texts[lang]?.[key] || texts.he[key];
}

function buildPreSummaryMessage(lang, ticketId, street, building, apartment, issue) {
  if (lang === "en") {
    return (
      `Thank you. Your report is almost ready.\n` +
      `Ticket number: ${ticketId}\n\n` +
      `Summary:\n` +
      `Street: ${street}\n` +
      `Building: ${building}\n` +
      `Apartment: ${apartment}\n` +
      `Issue: ${issue}\n\n` +
      `If you want, send a photo of the issue now.\n` +
      `If not, type "skip".`
    );
  }

  return (
    `תודה. הפנייה שלך כמעט מוכנה.\n` +
    `מספר פנייה: ${ticketId}\n\n` +
    `סיכום:\n` +
    `רחוב: ${street}\n` +
    `בניין: ${building}\n` +
    `דירה: ${apartment}\n` +
    `תקלה: ${issue}\n\n` +
    `אם תרצה, אפשר לשלוח עכשיו צילום של התקלה.\n` +
    `אם אין צילום, אפשר לכתוב "דלג".`
  );
}

function buildFinalSummaryMessage(lang, ticketId, street, building, apartment, issue, imageUrl) {
  if (lang === "en") {
    return (
      `✅ Your report has been received and forwarded for treatment.\n\n` +
      `Ticket number: ${ticketId}\n\n` +
      `Report details:\n` +
      `Street: ${street}\n` +
      `Building: ${building}\n` +
      `Apartment: ${apartment}\n` +
      `Issue: ${issue}\n` +
      `Photo attached: ${imageUrl ? "Yes" : "No"}\n\n` +
      `To open a new ticket, simply send a new message at any time.`
    );
  }

  return (
    `✅ הפנייה התקבלה והועברה לטיפול.\n\n` +
    `מספר פנייה: ${ticketId}\n\n` +
    `פרטי הפנייה:\n` +
    `רחוב: ${street}\n` +
    `בניין: ${building}\n` +
    `דירה: ${apartment}\n` +
    `תקלה: ${issue}\n` +
    `צילום צורף: ${imageUrl ? "כן" : "לא"}\n\n` +
    `לפתיחת פנייה חדשה, ניתן לשלוח הודעה חדשה בכל עת.`
  );
}

// ניקוי sessions ישנים פעם ב-10 דקות
setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.updatedAt > 60 * 60 * 1000) {
      sessions.delete(phone);
    }
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});