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

    // אם זה לא אירוע של הודעה אמיתית - מתעלמים
    if (!value.messages || !Array.isArray(value.messages) || value.messages.length === 0) {
      console.log("Webhook event is not a message");
      return;
    }

    const message = value.messages[0];

    // תומכים רק בטקסט
    if (message.type !== "text") {
      console.log("Unsupported message type:", message.type);
      return;
    }

    const messageId = message.id;
    const from = message.from;
    const body = (message.text?.body || "").trim();

    if (!messageId || !from || !body) {
      console.log("Missing messageId / from / body");
      return;
    }

    // מניעת כפילויות
    if (processedMessages.has(messageId)) {
      console.log("Duplicate message ignored:", messageId);
      return;
    }

    processedMessages.add(messageId);
    setTimeout(() => processedMessages.delete(messageId), 10 * 60 * 1000);

    console.log("User message:", { from, body });

    const replyText = await handleConversation(from, body);
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

async function handleConversation(phone, incomingText) {
  let session = sessions.get(phone);

  // התחלת שיחה
  if (!session) {
    const lang = detectLanguage(incomingText);

    session = {
      lang,
      step: "waiting_street",
      street: "",
      building: "",
      apartment: "",
      issue: "",
      updatedAt: Date.now()
    };

    sessions.set(phone, session);

    return getText(lang, "welcome");
  }

  session.updatedAt = Date.now();
  const text = incomingText.trim();

  if (session.step === "after_ticket") {
    if (text === "1") {
      session.step = "waiting_street";
      session.street = "";
      session.building = "";
      session.apartment = "";
      session.issue = "";
      return getText(session.lang, "ask_street_again");
    }

    if (text === "0") {
      sessions.delete(phone);
      return getText(session.lang, "end");
    }

    return getText(session.lang, "invalid_choice");
  }

  if (session.step === "waiting_street") {
    session.street = text;
    session.step = "waiting_building";
    return getText(session.lang, "ask_building");
  }

  if (session.step === "waiting_building") {
    session.building = text;
    session.step = "waiting_apartment";
    return getText(session.lang, "ask_apartment");
  }

  if (session.step === "waiting_apartment") {
    session.apartment = text;
    session.step = "waiting_issue";
    return getText(session.lang, "ask_issue");
  }

  if (session.step === "waiting_issue") {
    session.issue = text;

    // כתיבה ל-Google Sheets
    await writeTicketToSheet({
      phone,
      lang: session.lang,
      street: session.street,
      building: session.building,
      apartment: session.apartment,
      issue: session.issue
    });

    session.step = "after_ticket";

    return buildSummaryMessage(session.lang, session.street, session.building, session.apartment, session.issue);
  }

  // fallback
  session.step = "waiting_street";
  return getText(session.lang, "welcome");
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

function detectLanguage(text) {
  return /[\u0590-\u05FF]/.test(text) ? "he" : "en";
}

function getText(lang, key) {
  const texts = {
    he: {
      welcome:
        "שלום וברוכים הבאים למערכת פתיחת תקלות.\n\nבאיזה רחוב אתה גר?",
      ask_building:
        "תודה. מה מספר הבניין?",
      ask_apartment:
        "מעולה. מה מספר הדירה?",
      ask_issue:
        "אנא פרט מהי התקלה.",
      ask_street_again:
        "פתיחת פנייה חדשה.\nבאיזה רחוב אתה גר?",
      end:
        "תודה שפנית אלינו. השיחה הסתיימה.",
      invalid_choice:
        "לא זיהיתי את הבחירה.\nלחץ 1 לפתיחת פנייה חדשה\nלחץ 0 לסיום השיחה"
    },
    en: {
      welcome:
        "Hello and welcome to the fault reporting system.\n\nWhat street do you live on?",
      ask_building:
        "Thank you. What is the building number?",
      ask_apartment:
        "Great. What is the apartment number?",
      ask_issue:
        "Please describe the issue.",
      ask_street_again:
        "Starting a new report.\nWhat street do you live on?",
      end:
        "Thank you for contacting us. The conversation has ended.",
      invalid_choice:
        "I did not recognize your choice.\nPress 1 to open a new ticket\nPress 0 to end the conversation"
    }
  };

  return texts[lang]?.[key] || texts.he[key];
}

function buildSummaryMessage(lang, street, building, apartment, issue) {
  if (lang === "en") {
    return (
      "✅ Your report has been received and forwarded for treatment.\n\n" +
      "Report details:\n" +
      `Street: ${street}\n` +
      `Building: ${building}\n` +
      `Apartment: ${apartment}\n` +
      `Issue: ${issue}\n\n` +
      "Next step:\n" +
      "Press 1 to open a new ticket\n" +
      "Press 0 to end the conversation"
    );
  }

  return (
    "✅ הפנייה התקבלה והועברה לטיפול.\n\n" +
    "פרטי הפנייה:\n" +
    `רחוב: ${street}\n` +
    `בניין: ${building}\n` +
    `דירה: ${apartment}\n` +
    `תקלה: ${issue}\n\n` +
    "להמשך:\n" +
    "לחץ 1 לפתיחת פנייה חדשה\n" +
    "לחץ 0 לסיום השיחה"
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