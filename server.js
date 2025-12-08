require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const { jwt: { AccessToken } } = require("twilio");
const pool = require("./config/database");

const VoiceGrant = AccessToken.VoiceGrant;

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Allow requests from Chrome extension
app.use(cors({ origin: "*" })); // for development only

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

// Language-specific Intelligence Service SIDs based on country calling codes
const INTELLIGENCE_SERVICE_SIDS = {
  "+46": "GA8d3288496e7de4b67c414a3b8c47c002",  // SE - Sweden
  "+34": "GAdf2ee7a5d7d6bd4fea0bf2d468e345ab",  // ES - Spain
  "+351": "Aba2c65165933047cb8af54b7cae63729",  // PT - Portugal
  "+48": "GA34492937008b42a383b5972c739d792f",  // PL - Poland
  "+47": "GAbd6cecc52eed69251d909ef263b7fb72",  // NO - Norway
  "+39": "GA756e0686b44ed7b3f7ebf6282c6d4207",  // IT - Italy
  "+49": "GAbf3506556dbf0edcd7a4869a08532631",  // DE - Germany
  "+33": "GAf6e085d2f15aec836fac86fb832dea91",  // FR - France
  "+31": "GA714dfc9bbd6b7d254e08c4b7a15e9333",  // NL - Netherlands
  "+45": "GA83f41e1fdc0e12838904daecc1072bbc",  // DK - Denmark
};
const DEFAULT_SERVICE_SID = "GA21961a0d8e22442b498d6f5e970c45d4"; // EN - English (default)

// Country code to language code mapping
const COUNTRY_CODE_TO_LANGUAGE = {
  "+46": "sv-SE",  // Sweden
  "+34": "es-ES",  // Spain
  "+351": "pt-PT", // Portugal
  "+48": "pl-PL",  // Poland
  "+47": "no-NO",  // Norway
  "+39": "it-IT",  // Italy
  "+49": "de-DE",  // Germany
  "+33": "fr-FR",  // France
  "+31": "nl-NL",  // Netherlands
  "+45": "da-DK",  // Denmark
};

// Get the appropriate service SID based on phone number
function getServiceSidForPhoneNumber(phoneNumber) {
  if (!phoneNumber) return DEFAULT_SERVICE_SID;

  // Check for matching country codes (longest match first)
  const sortedCodes = Object.keys(INTELLIGENCE_SERVICE_SIDS).sort((a, b) => b.length - a.length);

  for (const code of sortedCodes) {
    if (phoneNumber.startsWith(code)) {
      console.log(`Detected country code ${code} for ${phoneNumber}`);
      return INTELLIGENCE_SERVICE_SIDS[code];
    }
  }

  console.log(`No matching country code for ${phoneNumber}, using default (EN)`);
  return DEFAULT_SERVICE_SID;
}

// Detect language code from phone number
function detectLanguageCode(phoneNumber) {
  if (!phoneNumber) return "en-US";

  const sortedCodes = Object.keys(COUNTRY_CODE_TO_LANGUAGE).sort((a, b) => b.length - a.length);

  for (const code of sortedCodes) {
    if (phoneNumber.startsWith(code)) {
      return COUNTRY_CODE_TO_LANGUAGE[code];
    }
  }

  return "en-US";
}


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
      action: `${process.env.BASE_URL}/call-status?from=${encodeURIComponent(fromNumber)}&to=${encodeURIComponent(toNumber)}`,  // final call status
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

  // Get fromNumber and toNumber from query parameters (passed from /voice action URL)
  const fromNumber = req.query.from;
  const toNumber = req.query.to;

  console.log("Call Status:", callStatus, "Call SID:", callSid);

  // Only summarize when call is fully completed
  if (callStatus === "completed") {
    // Fetch call details to check duration
    const call = await client.calls(callSid).fetch();
    const duration = parseInt(call.duration, 10) || 0;

    console.log("Call duration:", duration, "seconds, From:", fromNumber, "To:", toNumber);

    // Only create transcript for calls over 50 seconds
    if (duration > 50) {
      // Get user_id from the from_number
      const userId = await getUserIdFromPhoneNumber(fromNumber);

      const transcriptSid = await createSummarizationJob(callSid, toNumber);

      if (transcriptSid) {
        // Detect language code from to_number
        const languageCode = detectLanguageCode(toNumber);

        // Transcription takes time - poll after 30 seconds
        // For production, consider using webhooks instead
        setTimeout(async () => {
          const summary = await getCallSummary(transcriptSid);
          console.log("Call Summary:", summary);

          // Save summary to database
          if (summary) {
            await saveCallSummary({
              userId,
              callSid,
              transcriptSid,
              fromNumber,
              toNumber,
              duration,
              summary,
              languageCode
            });
          }
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
async function createSummarizationJob(callSid, toNumber) {
  try {
    // Wait for the recording to be ready
    const recording = await waitForRecording(callSid);

    if (!recording) {
      console.log("No completed recording found for call:", callSid);
      return null;
    }

    console.log("Recording found:", recording.sid, "Status:", recording.status);

    // Get the appropriate service SID based on the destination phone number
    const serviceSid = getServiceSidForPhoneNumber(toNumber);
    console.log("Using Intelligence Service:", serviceSid);

    // Create a transcript using the Voice Intelligence API
    const transcript = await client.intelligence.v2.transcripts.create({
      channel: {
        media_properties: {
          source_sid: recording.sid,
        },
      },
      serviceSid: serviceSid,
    });

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

      console.log(operatorResults);
    // Find the summarize operator result
    const summaryResult = operatorResults.find(
      (result) => result.name === "Call Summary"
      // (result) => result.name === "Call Summary" ||
      //             result.operatorType === "text-generation"
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

// Get user_id from phone number (from_number)
async function getUserIdFromPhoneNumber(phoneNumber) {
  try {
    if (!phoneNumber) return null;

    // Normalize phone number (remove any non-digit characters except +)
    const normalizedNumber = phoneNumber.replace(/[^\d+]/g, '');

    const result = await pool.query(
      `SELECT user_id FROM user_configurations WHERE phone_number = $1`,
      [normalizedNumber]
    );

    if (result.rows.length > 0) {
      console.log(`Found user_id ${result.rows[0].user_id} for phone number ${normalizedNumber}`);
      return result.rows[0].user_id;
    }

    console.log(`No user found for phone number ${normalizedNumber}`);
    return null;
  } catch (err) {
    console.error("Error getting user_id from phone number:", err);
    return null;
  }
}

// Save call summary to database
async function saveCallSummary(callData) {
  try {
    const { userId, callSid, transcriptSid, fromNumber, toNumber, duration, summary, languageCode } = callData;

    const result = await pool.query(
      `INSERT INTO call_summaries (user_id, call_sid, transcript_sid, from_number, to_number, duration, summary, language_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (call_sid) DO UPDATE SET
         summary = EXCLUDED.summary,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [userId, callSid, transcriptSid, fromNumber, toNumber, duration, summary, languageCode]
    );

    console.log(`Call summary saved with id: ${result.rows[0].id}`);
    return result.rows[0].id;
  } catch (err) {
    console.error("Error saving call summary:", err);
    return null;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));