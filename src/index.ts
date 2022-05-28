import express from "express";
import fetch from "node-fetch";
import { engine } from "express-handlebars";
import { urlencoded } from "body-parser";
import path from "path";
import { createClient } from "@supabase/supabase-js";

import { SlackAuthResponse, Cache } from "./types";

import dotenv from "dotenv";
dotenv.config();

const environmentVariables = [
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
];
for (const env of environmentVariables) {
  if (!process.env[env]) {
    console.error(`Please define ${env}`);
    process.exit(1);
  }
}

const cache: Cache = {
  event_id: "",
  event_time: 0,
  users: {},
};

const app = express();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

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
    `https://slack.com/api/oauth.v2.access?code=${req.query.code}&client_id=${
      process.env.SLACK_CLIENT_ID
    }&client_secret=${process.env.SLACK_CLIENT_SECRET}&redirect_uri=${
      process.env.HOST ?? "http://localhost:3000"
    }/slack`,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    }
  );

  const authJson = (await auth.json()) as SlackAuthResponse;
  if (!authJson.ok && authJson.error) {
    console.log(`error getting slack token: ${authJson.error}`);
    res.send(`Error occured: \n${authJson.error}`);
    return;
  }

  if (authJson.ok) {
    let user = await supabase
      .from("users")
      .select()
      .eq("user_id", authJson.authed_user.id);
    if (user?.data?.length === 0) {
      await supabase.from("users").insert([
        {
          user_id: authJson.authed_user.id,
          slack_token: authJson.authed_user.access_token,
        },
      ]);
    }
  }

  res.render("success");
});

app.post("/event", async (req, res) => {
  if (req.body.challenge) return res.send(req.body.challenge).status(200);

  const { event } = req.body;

  if (event.type != "message") return res.status(400);
  if (
    req.body.event_id === cache.event_id ||
    req.body.event_time < cache.event_time
  )
    return res.status(200);

  cache.event_id = req.body.event_id;
  cache.event_time = req.body.event_time;

  // If the message was sent within 3 minutes of the last message from the user, do nothing.
  if (
    cache.users[event.user] &&
    cache.users[event.user].channel === event.channel &&
    new Date().getTime() - cache.users[event.user].latest_time < 3 * 60000
  )
    return res.status(200);

  const { data, error } = await supabase
    .from("users")
    .select()
    .eq("user_id", event.user);

  if (error) {
    console.error(error);
    return res
      .send(`Error while fetching user from database. ${error}`)
      .status(404);
  }

  if (data === null || data.length === 0)
    return res.send(`User not found in database.`).status(404);

  let channel = await fetch(
    `https://slack.com/api/conversations.info?channel=${event.channel}`,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${data[0]["slack_token"]}`,
      },
      method: "GET",
    }
  ).then((res) => res.json());

  if (!channel.ok)
    return res.send(`Channel not found. ${channel.error}`).status(404);

  let userData = await fetch(
    `https://slack.com/api/users.profile.get?user=${event.user}`,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${data[0]["slack_token"]}`,
      },
      method: "GET",
    }
  ).then((res) => res.json());

  if (userData.error) {
    console.log("Error finding user: " + event.user);
    return res.send(`User not found. ${event.user}`).status(404);
  }

  if (
    userData.profile &&
    (userData.profile.status_text === "" ||
      userData.profile.status_text.startsWith("Chatting in #")) &&
    (userData.profile.status_emoji === "" ||
      userData.profile.status_emoji === ":tw_speech_balloon:")
  ) {
    await fetch("https://slack.com/api/users.profile.set", {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data[0]["slack_token"]}`,
      },
      method: "POST",
      body: JSON.stringify({
        profile: {
          status_text: `Chatting in #${channel?.channel.name}!`,
          status_emoji: ":tw_speech_balloon:",
          status_expiration:
            new Date(new Date().getTime() + 10 * 60000).getTime() / 1000,
        },
      }),
    });

    cache.users[data[0].user_id] = {
      channel: event.channel,
      latest_time: new Date().getTime(),
    };
  } else return res.status(400);
  res.status(400);
});

app.listen(process.env.PORT ?? 3000, () => {
  console.log(
    `🚀 Server ready at: ${process.env.HOST ?? "http://localhost:3000"}`
  );
});
