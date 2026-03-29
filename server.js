const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.use(express.json());

// ========== ENVIRONMENT VARIABLES ==========
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'bamakor-super-secret-jwt-key-2024-yoni-levakor';

// Google Apps Script
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// WhatsApp Configuration
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '12345';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Email Configuration
const EMAIL_USER = process.env.EMAIL_USER || 'levyyoni5@gmail.com';
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;

console.log(`\n🚀 ========== BAMAKOR SERVER ==========`);
console.log(`🔧 Environment: ${NODE_ENV}`);
console.log(`📍 Port: ${PORT}`);
console.log(`✅ Google Client ID: ${GOOGLE_CLIENT_ID ? '✓ Configured' : '❌ Missing'}`);
console.log(`✅ JWT Secret: ${JWT_SECRET ? '✓ Configured' : '❌ Missing'}`);
console.log(`✅ Apps Script URL: ${APPS_SCRIPT_URL ? '✓ Configured' : '❌ Missing'}`);
console.log(`✅ WhatsApp Token: ${WHATSAPP_TOKEN ? '✓ Configured' : '❌ Missing'}`);
console.log(`✅ Email Config: ${EMAIL_USER ? '✓ Configured' : '❌ Missing'}`);
console.log(`=====================================\n`);

// זיכרון זמני לניהול שיחה לפי טלפון
const sessions = new Map();
// מניעת עיבוד כפול של אותה הודעה
const processedMessages = new Set();

// ========== STATIC FILES ==========
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/dashboard.html", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, timestamp: new Date().toISOString() });
});

// ========== GOOGLE AUTH ==========

app.post("/api/auth/google", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ ok: false, error: "No token provided" });
    }

    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL" });
    }

    // Verify token with Apps Script
    const verifyResponse = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "getUser",
        token: token
      })
    });

    const userData = await verifyResponse.json();

    if (!userData.ok || !userData.user) {
      return res.status(401).json({ ok: false, error: "User not found or unauthorized" });
    }

    // Create JWT Token
    const jwtToken = jwt.sign(
      { 
        email: userData.user.email, 
        role: userData.user.role, 
        name: userData.user.name 
      },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    console.log(`✅ User logged in: ${userData.user.email} (${userData.user.role})`);

    res.json({
      ok: true,
      token: jwtToken,
      user: {
        email: userData.user.email,
        name: userData.user.name,
        role: userData.user.role
      }
    });

  } catch (error) {
    console.error("❌ Google Auth Error:", error);
    res.status(401).json({ ok: false, error: "Authentication failed" });
  }
});

// ========== VERIFY JWT MIDDLEWARE ==========

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ ok: false, error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
}

// ========== WEBHOOK ENDPOINTS ==========

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("❌ Invalid webhook verification");
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
    console.error("❌ Webhook error:", error);
  }
});

// ========== PROTECTED API ENDPOINTS ==========

app.get("/api/tickets", verifyToken, async (req, res) => {
  try {
    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL env variable" });
    }

    const response = await fetch(`${APPS_SCRIPT_URL}?action=listTickets`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    console.error("❌ GET /api/tickets error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/employees", verifyToken, async (req, res) => {
  try {
    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL env variable" });
    }

    const response = await fetch(`${APPS_SCRIPT_URL}?action=listEmployees`);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    console.error("❌ GET /api/employees error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/tickets/status", verifyToken, async (req, res) => {
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
    console.log(`✅ Ticket ${ticketId} status updated to ${status}`);
    res.json(data);
  } catch (error) {
    console.error("❌ POST /api/tickets/status error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/tickets/assign", verifyToken, async (req, res) => {
  try {
    const { ticketId, assignedTo, email } = req.body || {};

    if (!ticketId || !assignedTo || !email) {
      return res.status(400).json({
        ok: false,
        error: "Missing ticketId, assignedTo, or email"
      });
    }

    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL env variable" });
    }

    console.log(`📨 Assigning ticket ${ticketId} to ${assignedTo}`);

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

    const emailResponse = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        action: "sendEmail",
        email,
        assignedTo,
        ticketId
      })
    });

    const emailData = await emailResponse.json();

    if (!emailData.ok) {
      console.error("⚠️ Email send failed:", emailData);
      return res.status(500).json({
        ok: false,
        error: "Ticket assigned but email failed"
      });
    }

    console.log(`✅ Ticket ${ticketId} assigned and email sent to ${email}`);
    res.json({
      ok: true,
      message: "Ticket assigned and email sent successfully"
    });

  } catch (error) {
    console.error("❌ POST /api/tickets/assign error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/tickets/notes", verifyToken, async (req, res) => {
  try {
    const { ticketId, notes } = req.body || {};

    if (!ticketId) {
      return res.status(400).json({
        ok: false,
        error: "Missing ticketId"
      });
    }

    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL env variable" });
    }

    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        action: "updateNotes",
        ticketId,
        notes: notes || ""
      })
    });

    const data = await response.json();
    console.log(`✅ Notes updated for ticket ${ticketId}`);
    res.json(data);
  } catch (error) {
    console.error("❌ POST /api/tickets/notes error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/tickets/delete", verifyToken, async (req, res) => {
  try {
    const { ticketId } = req.body || {};

    if (!ticketId) {
      return res.status(400).json({
        ok: false,
        error: "Missing ticketId"
      });
    }

    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "Missing APPS_SCRIPT_URL env variable" });
    }

    const response = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        action: "deleteTicket",
        ticketId
      })
    });

    const data = await response.json();
    console.log(`✅ Ticket ${ticketId} deleted`);
    res.json(data);
  } catch (error) {
    console.error("❌ POST /api/tickets/delete error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ========== WHATSAPP CONVERSATION HANDLERS ==========

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

  console.log(`✅ Ticket ${data.ticketId} created via WhatsApp`);
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

  console.log(`✅ WhatsApp message sent to ${to}`);
}

function generateTicketId() {
  const random = Math.floor(100000 + Math.random() * 900000);
  return `BMK-${random}`;
}

function getLanguageSelectionText() {
  return (
    "ברוכים הבאים למוקד התקלות של Bamakor\n" +
    "Welcome to Bamakor maintenance desk\n\n" +
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
      `Report has been received and forwarded for treatment.\n\n` +
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
    `הפנייה התקבלה והועברה לטיפול.\n\n` +
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
      console.log(`🗑️ Cleaned up session for ${phone}`);
    }
  }
}, 10 * 60 * 1000);

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`\n✅ Bamakor server is running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`🔗 API: http://localhost:${PORT}/api/`);
  console.log(`📱 WebHook: http://localhost:${PORT}/webhook`);
  console.log(`❤️  Health: http://localhost:${PORT}/health\n`);
});
