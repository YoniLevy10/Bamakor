const express = require("express");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "12345";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;

// זיכרון זמני לניהול שיחה לפי טלפון
const sessions = new Map();
// מניעת עיבוד כפול של אותה הודעה
const processedMessages = new Set();

// Setup Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASSWORD
  }
});

/**
 * ROOT - מגיש את הדשבורד מהשורש של הפרויקט
 */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/dashboard.html", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages || !Array.isArray(value.messages) || value.messages.length === 0) {
      return;
    }

    const message = value.messages[0];
    const messageId = message.id;
    const from = message.from;
    const messageType = message.type;

    if (!messageId || !from) return;

    if (processedMessages.has(messageId)) {
      return;
    }

    processedMessages.add(messageId);
    setTimeout(() => processedMessages.delete(messageId), 10 * 60 * 1000);

    const replyText = await handleConversation(from, message);

    if (!replyText) return;

    await sendWhatsAppMessage(from, replyText);
  } catch (error) {
    console.error("Webhook error:", error);
  }
});

/**
 * שליפת כל הפניות לדשבורד
 */
app.get("/api/tickets", async (req, res) => {
  try {
    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL env variable" });
    }

    const response = await fetch(`${APPS_SCRIPT_URL}?action=listTickets`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    console.error("GET /api/tickets error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * שליפת רשימת עובדים מ-Google Sheets
 */
app.get("/api/employees", async (req, res) => {
  try {
    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL env variable" });
    }

    const response = await fetch(`${APPS_SCRIPT_URL}?action=listEmployees`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    console.error("GET /api/employees error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * עדכון סטטוס פנייה מהדשבורד
 */
app.post("/api/tickets/status", async (req, res) => {
  try {
    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL env variable" });
    }

    const { ticketId, status } = req.body || {};

    if (!ticketId || !status) {
      return res.status(400).json({
        ok: false,
        error: "Missing ticketId or status"
      });
    }

    const allowedStatuses = ["פתוח", "סגור"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid status"
      });
    }

    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        action: "updateStatus",
        ticketId,
        status
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("POST /api/tickets/status error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * הקצאת פנייה לעובד ושליחת מייל
 * מצפה לקבל:
 * {
 *   ticketId: "BMK-123456",
 *   assignedTo: "שם העובד",
 *   email: "worker@example.com"
 * }
 */
app.post("/api/tickets/assign", async (req, res) => {
  try {
    const { ticketId, assignedTo, email } = req.body || {};

    if (!ticketId || !assignedTo || !email) {
      return res.status(400).json({
        ok: false,
        error: "Missing ticketId, assignedTo, or email"
      });
    }

    // עדכן ב-Google Sheets
    const updateResponse = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        action: "assignTicket",
        ticketId,
        assignedTo,
        email
      })
    });

    const updateData = await updateResponse.json();

    if (!updateData.ok) {
      return res.status(400).json({
        ok: false,
        error: updateData.error || "Failed to assign ticket"
      });
    }

    // שלח מייל
    const mailOptions = {
      from: EMAIL_USER,
      to: email,
      subject: `🔧 הוקצאה לך משימה לטיפול - ${ticketId}`,
      html: `
        <div style="font-family: Arial, sans-serif; direction: rtl; text-align: right; background: #f5f5f5; padding: 20px;">
          <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto;">
            <div style="border-left: 5px solid #C41E3A; padding-left: 20px; margin-bottom: 20px;">
              <h2 style="color: #3F3F3F; margin: 0 0 10px 0;">שלום ${assignedTo}! 👋</h2>
              <p style="color: #666; margin: 0;">הוקצאה לך משימה חדשה לטיפול</p>
            </div>
            
            <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
              <p style="color: #666; margin: 5px 0;">
                <strong>מספר משימה:</strong> <span style="color: #C41E3A; font-weight: bold; font-size: 16px;">${ticketId}</span>
              </p>
              <p style="color: #666; margin: 5px 0;">
                <strong>תאריך הקצאה:</strong> ${new Date().toLocaleString('he-IL')}
              </p>
            </div>
            
            <p style="color: #666; margin-bottom: 20px;">אנא בדוק בדשבורד לפרטים נוספים על המשימה.</p>
            
            <div style="text-align: center;">
              <a href="https://bamakor.onrender.com/" style="background: #C41E3A; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: 600;">
                📊 עבור לדשבורד
              </a>
            </div>
            
            <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
            
            <p style="color: #999; font-size: 12px; margin: 0; text-align: center;">
              מערכת ניהול משימות Bamakor<br>
              bamakor.com
            </p>
          </div>
        </div>
      `
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("Email error:", error);
        return res.status(500).json({
          ok: false,
          error: "Ticket assigned but email failed to send"
        });
      }
      res.json({
        ok: true,
        message: "Ticket assigned and email sent successfully"
      });
    });

  } catch (error) {
    console.error("POST /api/tickets/assign error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * הורדת תמונה מ-WhatsApp
 */
app.get("/api/download-image", async (req, res) => {
  try {
    const mediaId = req.query.mediaId;
    
    if (!mediaId) {
      return res.status(400).json({ error: "Missing mediaId" });
    }

    if (!WHATSAPP_TOKEN) {
      return res.status(500).json({ error: "Missing WHATSAPP_TOKEN" });
    }

    // אם זה כבר URL
    if (mediaId.startsWith('http')) {
      return res.json({ url: mediaId });
    }

    // אם זה whatsapp-media-id
    if (mediaId.startsWith('whatsapp-media-id:')) {
      const actualMediaId = mediaId.replace('whatsapp-media-id:', '');
      
      // קרא ל-Meta API להשיג את URL התמונה
      const mediaResponse = await fetch(
        `https://graph.instagram.com/v18.0/${actualMediaId}/?access_token=${WHATSAPP_TOKEN}`
      );

      if (!mediaResponse.ok) {
        return res.status(400).json({ error: "Failed to fetch media" });
      }

      const mediaData = await mediaResponse.json();
      return res.json({ url: mediaData.media_object?.image || null });
    }

    res.status(400).json({ error: "Invalid mediaId format" });
  } catch (error) {
    console.error("GET /api/download-image error:", error);
    res.status(500).json({ error: error.message });
  }
});

async function handleConversation(phone, message) {
  let session = sessions.get(phone);
  const messageType = message.type;
  const text = (message.text?.body || "").trim();

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
    if (messageType !== "text") return getText(session.lang, "street_text_only");
    session.street = text;
    session.step = "waiting_building";
    return getText(session.lang, "ask_building");
  }

  if (session.step === "waiting_building") {
    if (messageType !== "text") return getText(session.lang, "building_text_only");
    session.building = text;
    session.step = "waiting_apartment";
    return getText(session.lang, "ask_apartment");
  }

  if (session.step === "waiting_apartment") {
    if (messageType !== "text") return getText(session.lang, "apartment_text_only");
    session.apartment = text;
    session.step = "waiting_issue";
    return getText(session.lang, "ask_issue");
  }

  if (session.step === "waiting_issue") {
    if (messageType !== "text") return getText(session.lang, "issue_text_only");
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
    if (messageType === "image") {
      const imageId = message.image?.id || "";
      session.imageUrl = imageId ? `whatsapp-media-id:${imageId}` : "";
    }

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

  const response = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "addTicket",
      ...data
    })
  });

  const rawText = await response.text();

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
      ask_street: "שלום וברוכים הבאים למוקד התקלות של Bamakor.\n\nנא לציין את שם הרחוב.",
      ask_building: "תודה. נא לציין את מספר הבניין.",
      ask_apartment: "מעולה. נא לציין את מספר הדירה.",
      ask_issue: "אנא פרט בקצרה מהי התקלה.",
      street_text_only: "נא לרשום את שם הרחוב בטקסט בלבד.",
      building_text_only: "נא לרשום את מספר הבניין בטקסט בלבד.",
      apartment_text_only: "נא לרשום את מספר הדירה בטקסט בלבד.",
      issue_text_only: "נא לפרט את התקלה בטקסט בלבד."
    },
    en: {
      ask_street: "Hello and welcome to the Bamakor maintenance desk.\n\nPlease enter the street name.",
      ask_building: "Thank you. Please enter the building number.",
      ask_apartment: "Great. Please enter the apartment number.",
      ask_issue: "Please briefly describe the issue.",
      street_text_only: "Please enter the street name as text only.",
      building_text_only: "Please enter the building number as text only.",
      apartment_text_only: "Please enter the apartment number as text only.",
      issue_text_only: "Please describe the issue as text only."
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
