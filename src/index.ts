import express from "express";
import fetch from "node-fetch";
import { engine } from "express-handlebars";
import { urlencoded } from "body-parser";
import path from "path";
import { WebClient } from "@slack/web-api";

import dotenv from "dotenv";
import { SlackAuthResponse } from "./types";
dotenv.config();

const app = express();
const slackClient = new WebClient(process.env.SLACK_TOKEN);

app.use(express.json());
app.use(express.static("public"));
app.use(urlencoded({ extended: true }));

app.set("view engine", "html");
app.set("views", path.join(__dirname, "..", "/views"));
app.engine(
  "html",
  engine({
    extname: ".html",
  })
);

app.get("/", (req, res) => {
  res.render("main", {
    slackClientID: process.env.SLACK_CLIENT_ID,
    host: process.env.HOST ?? "http://localhost:3000",
  });
});

app.get("/slack", async (req, res) => {
  if (req.query.error) {
    console.log(`error authenticating:\n${JSON.stringify(req.query, null, 4)}`);
    return;
  }

  const auth = await fetch(
    `https://slack.com/api/oauth.v2.access?code=${req.query.code}&client_id=${process.env.SLACK_CLIENT_ID}&client_secret=${process.env.SLACK_CLIENT_SECRET}`,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    }
  );

  const authJson = (await auth.json()) as SlackAuthResponse;
  if (!authJson.ok) {
    if (authJson.error) {
      console.log(`error getting slack token: ${authJson.error}`);
    }
    res.send(`Error occured: \n${authJson.error}`);
    return;
  }

  res.render("success");
});

app.post("/event", async (req, res) => {
  if (req.body.challenge) {
    return res.send(req.body.challenge).status(200);
  }
  if (req.body.event.type === "message") {
    if (req.body.event.user === "U01PNGGBBT5") {
      let { channel } = await slackClient.conversations.info({
        channel: req.body.event.channel,
      });
      await slackClient.users.profile.set({
        profile: JSON.stringify({
          status_text: `Talking in #${channel?.name}!`,
          status_emoji: ":tw_speech_balloon:",
          status_expiration:
            new Date(new Date().getTime() + 10 * 60000).getTime() / 1000,
        }),
      });
    }
  }
  res.status(404);
});

app.listen(3000, () => {
  console.log(
    `🚀 Server ready at: ${process.env.HOST ?? "http://localhost:3000"}`
  );
});
