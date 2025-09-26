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

// Handle TwiML instructions for outbound calls
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  let toNumber = req.body.To;
  let fromNumber = req.body.From;
  let channelID = req.body.ChannelID;

  console.log(`fromNumber: ${fromNumber}, toNumber: ${voicemailUrl}`);
  if (toNumber) {
    // Dial the lead's number from your Twilio number
    const dial = twiml.dial({ 
      callerId: fromNumber,
      record: "record-from-answer-dual",
      action: `${process.env.BASE_URL}/call-status`,  // final call status
      method: "POST"
    });
    
    
    dial.number(toNumber);
  } else {
    console.log("No number provided.");
    twiml.say("No number provided.");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

app.get('/get-call-info', async (req, res) => {
  const { callSid } = req.query;

  try {
    const call = await client.calls(callSid).fetch();
    const recordings = await client.recordings.list({ callSid });

    console.log(`call duration: ${ call.duration}`);
    res.json({
      duration: call.duration,  // in seconds
      status: call.status,
      recordingUrl: recordings.length > 0 ? recordings[0].mediaUrl : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/leave-voicemail", async (req, res) => {
  const { fromNumber, toNumber, voicemailUrl } = req.body;

  if (!toNumber || !voicemailUrl) {
    return res.status(400).json({ error: "toNumber and voicemailUrl required" });
  }

  try {
    const call = await client.calls.create({
      url: `${process.env.BASE_URL}/answer?voicemailUrl=${encodeURIComponent(voicemailUrl)}`,
      to: toNumber,   // recipient
      from: fromNumber, // your Twilio number
      machineDetection: "DetectMessageEnd" // detect voicemail greeting end
    });

    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/answer", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const answeredBy = req.body.AnsweredBy || "unknown";
  const voicemailUrl = req.query.voicemailUrl;
  console.log(`voiceemailurl left: ${voicemailUrl}`); 

  if (answeredBy === "human") {
    // Human answered → play message right away
    twiml.play(voicemailUrl);
  } else if (answeredBy === "machine_end_beep") {
    // Voicemail detected, greeting finished → leave voicemail
    twiml.play(voicemailUrl);
  } else {
    // Fallback if uncertain
    twiml.say("Sorry, we’ll try again later.");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/call-status", async (req, res) => {
  res.sendStatus(200);
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));