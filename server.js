const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "12345";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

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
  try {
    console.log("Incoming webhook body:", JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log("No message found in webhook");
      return res.sendStatus(200);
    }

    if (message.type !== "text") {
      console.log("Unsupported message type:", message.type);
      return res.sendStatus(200);
    }

    const from = message.from;
    const body = message.text?.body?.trim() || "";

    if (!from || !body) {
      console.log("Missing from/body");
      return res.sendStatus(200);
    }

    if (!APPS_SCRIPT_URL) {
      console.error("Missing APPS_SCRIPT_URL env variable");
      return res.sendStatus(500);
    }

    if (!WHATSAPP_TOKEN) {
      console.error("Missing WHATSAPP_TOKEN env variable");
      return res.sendStatus(500);
    }

    if (!PHONE_NUMBER_ID) {
      console.error("Missing PHONE_NUMBER_ID env variable");
      return res.sendStatus(500);
    }

    console.log("Sending message to Apps Script:", { from, body });

    const scriptResponse = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        body
      })
    });

    const scriptText = await scriptResponse.text();
    console.log("Apps Script raw response:", scriptText);

    let scriptData;
    try {
      scriptData = JSON.parse(scriptText);
    } catch (parseError) {
      console.error("Failed to parse Apps Script response as JSON");
      return res.sendStatus(500);
    }

    const replyText = scriptData.reply || "ההודעה התקבלה.";
    console.log("Reply text:", replyText);

    const whatsappResponse = await fetch(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          text: {
            body: replyText
          }
        })
      }
    );

    const whatsappText = await whatsappResponse.text();
    console.log("WhatsApp API response:", whatsappText);

    if (!whatsappResponse.ok) {
      console.error("Failed sending message to WhatsApp");
      return res.sendStatus(500);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});