require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const { jwt: { AccessToken } } = require("twilio");

const VoiceGrant = AccessToken.VoiceGrant;

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Allow requests from Chrome extension
app.use(cors({ origin: "*" })); // for development only

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;


// Generate Access Token for browser
app.get("/token", (req, res) => {
  const identity = `guest-${Date.now()}`;
  console.log(identity);

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWIML_APP_SID,
    incomingAllow: true
  });

  token.addGrant(voiceGrant);

  res.send({ token: token.toJwt() });
});

app.post("/leave-voicemail", async (req, res) => {
  const { fromNumber, toNumber, voicemailUrl, leadID, campaignID } = req.body;

  if (!toNumber || !voicemailUrl || !leadID || !campaignID) {
    return res.status(400).json({ error: "toNumber, voicemailUrl, leadID, and campaignID required" });
  }

  try {
    const answerUrl = `${process.env.BASE_URL}/answer?voicemailUrl=${encodeURIComponent(voicemailUrl)}&leadID=${leadID}&campaignID=${campaignID}`;

    const call = await client.calls.create({
      url: answerUrl,
      to: toNumber,   // recipient
      from: fromNumber || twilioNumber, // use provided number or default Twilio number
      machineDetection: "DetectMessageEnd", // detect voicemail greeting end
      statusCallback: `${process.env.BASE_URL}/call-status?leadID=${leadID}&campaignID=${campaignID}`,
      statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer']
    });

    console.log(`Call initiated: ${call.sid} for lead ${leadID}, campaign ${campaignID}`);
    res.json({ success: true, callSid: call.sid, leadID, campaignID });
  } catch (err) {
    const sendTracking = async (status) => {
    try {
      await axios.post(`${process.env.BACKEND_URL}/api/voicemail/track`, {
          leadID: leadID,
          campaignID: campaignID,
          status: status
        });
        console.log(`Tracking sent: ${status} for lead ${leadID}`);
      } catch (error) {
        console.error('Error sending tracking:', error.message);
      }
    };

    await sendTracking("failed");
    console.error('Error creating call:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/answer", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const answeredBy = req.body.AnsweredBy || "unknown";
  const voicemailUrl = req.query.voicemailUrl;
  const leadID = req.query.leadID;
  const campaignID = req.query.campaignID;

  console.log(`Answer webhook - AnsweredBy: ${answeredBy}, Lead: ${leadID}, Campaign: ${campaignID}`);
  console.log(`Voicemail URL: ${voicemailUrl}`);

  // Send tracking information to backend
  const sendTracking = async (status) => {
    try {
      await axios.post(`${process.env.BACKEND_URL}/api/voicemail/track`, {
        leadID: leadID,
        campaignID: campaignID,
        status: status
      });
      console.log(`Tracking sent: ${status} for lead ${leadID}`);
    } catch (error) {
      console.error('Error sending tracking:', error.message);
    }
  };

  if (answeredBy === "human") {
    // Human answered → play message right away
    twiml.play(voicemailUrl);
    await sendTracking("human");
  } else if (answeredBy === "machine_end_beep") {
    // Voicemail detected, greeting finished → leave voicemail
    twiml.play(voicemailUrl);
    await sendTracking("machine_end_beep");
  } else {
    // Fallback if uncertain or failed
    twiml.say("Sorry, we’ll try again later.");
    await sendTracking("failed");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/call-status", async (req, res) => {
  res.sendStatus(200);
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));