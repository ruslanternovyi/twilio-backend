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

  console.log(`fromNumber: ${fromNumber}, toNumber: ${toNumber}`);
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
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  console.log("Call Status:", callStatus, "Call SID:", callSid);

  // Only summarize when call is fully completed
  if (callStatus === "completed") {
    // Fetch call details to check duration
    const call = await client.calls(callSid).fetch();
    const duration = parseInt(call.duration, 10) || 0;

    console.log("Call duration:", duration, "seconds");

    // Only create transcript for calls over 50 seconds
    if (duration > 50) {
      const transcriptSid = await createSummarizationJob(callSid);

      if (transcriptSid) {
        // Transcription takes time - poll after 30 seconds
        // For production, consider using webhooks instead
        setTimeout(async () => {
          const summary = await getCallSummary(transcriptSid);
          console.log("Call Summary:", summary);

          // TODO: Save to DB, send to frontend, etc.
        }, 30000);
      }
    } else {
      console.log("Call too short for summarization, skipping...");
    }
  }

  res.sendStatus(200);
});


// Helper function to wait for recording to be ready
async function waitForRecording(callSid, maxAttempts = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const recordings = await client.recordings.list({ callSid, limit: 1 });

    if (recordings.length > 0 && recordings[0].status === "completed") {
      console.log(`Recording ready after ${attempt} attempt(s)`);
      return recordings[0];
    }

    console.log(`Waiting for recording... attempt ${attempt}/${maxAttempts}`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  return null;
}

// Create a Conversation Intelligence Transcript when call ends
async function createSummarizationJob(callSid) {
  try {
    // Wait for the recording to be ready
    const recording = await waitForRecording(callSid);

    if (!recording) {
      console.log("No completed recording found for call:", callSid);
      return null;
    }

    console.log("Recording found:", recording.sid, "Status:", recording.status);

    // Create a transcript using the Voice Intelligence API
    const transcript = await client.intelligence.v2.transcripts.create({
      channel: {
        media_properties: {
          source_sid: recording.sid,
        },
      },
      serviceSid: process.env.CONVERSATION_INTELLIGENCE_SERVICE_SID,
    });
    console.log(transcript);

    console.log("Transcript created:", transcript.sid);
    return transcript.sid;

  } catch (err) {
    console.error("Error creating transcript:", err);
    return null;
  }
}

async function getCallSummary(transcriptSid) {
  try {
    if (!transcriptSid) {
      return null;
    }

    // Fetch the operator results for the transcript
    const operatorResults = await client.intelligence.v2
      .transcripts(transcriptSid)
      .operatorResults
      .list();

    // Find the summarize operator result
    const summaryResult = operatorResults.find(
      (result) => result.name === "Conversation Summary" ||
                  result.operatorType === "text-generation"
    );

    if (summaryResult?.textGenerationResults?.result) {
      return summaryResult.textGenerationResults.result;
    }

    return null;

  } catch (err) {
    console.error("Error fetching summary:", err);
    return null;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));