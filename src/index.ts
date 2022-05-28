import express from "express";
import fetch from "node-fetch";
import { engine } from "express-handlebars";
import { urlencoded } from "body-parser";
import path from "path";
import { createClient, User } from "@supabase/supabase-js";

import { SlackAuthResponse, Cache } from "./types";

import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
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

app.get("/", (_req, res) => {
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
      cache.users[authJson.authed_user.id] = {
        channel: "",
        latest_time: 0,
        latest_delete_time: 0,
        token: authJson.authed_user.access_token,
        id: authJson.authed_user.id,
      };
    } else {
      await supabase
        .from("users")
        .update({ slack_token: authJson.authed_user.access_token })
        .eq("user_id", authJson.authed_user.id);
      cache.users[authJson.authed_user.id].token =
        authJson.authed_user.access_token;
    }
  }

  res.render("success");
});

app.post("/event", async (req, res) => {
  if (req.body.challenge) return res.status(200).send(req.body.challenge);

  const { event } = req.body;

  if (event.type != "message")
    return res.status(400).send(`Event type is not message.`);

  if (
    req.body.event_id === cache.event_id ||
    req.body.event_time < cache.event_time
  )
    return res.status(200).send(`Old message's event triggered.`);
  cache.event_id = req.body.event_id;
  cache.event_time = req.body.event_time;

  if (!cache.users[event.user])
    return res.status(404).send(`User has not authorized.`);

  if (event.text.match(/^[dD]*$/gi)) {
    if (
      cache.users[event.user] &&
      new Date().getTime() - cache.users[event.user].latest_delete_time <
        30 * 1000
    )
      return res.status(200).send("Ratelimited");
    return await handleInstantDelete(req, res, event, cache.users[event.user]);
  }

  // If the message was sent within 3 minutes of the last message from the user, do nothing.
  if (
    cache.users[event.user] &&
    cache.users[event.user].channel === event.channel &&
    new Date().getTime() - cache.users[event.user].latest_time < 10 * 60000
  )
    return res.status(200).send(`Request accepted but not acted upon`);

  console.log(`User found in database: ${event.user}`);

  let channel = await fetch(
    `https://slack.com/api/conversations.info?channel=${event.channel}`,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${cache.users[event.user]["token"]}`,
      },
      method: "GET",
    }
  ).then((res) => res.json());

  if (!channel.ok) {
    console.error(`Channel not found: ${event.channel}`);
    return res.status(404).send(`Channel not found. ${channel.error}`);
  }

  let userData = await fetch(
    `https://slack.com/api/users.profile.get?user=${event.user}`,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${cache.users[event.user]["token"]}`,
      },
      method: "GET",
    }
  ).then((res) => res.json());

  if (userData.error) {
    console.log("Error finding user: " + event.user);
    return res.status(404).send(`User not found. ${event.user}`);
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
        Authorization: `Bearer ${cache.users[event.user].token}`,
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
    console.log(
      `Updated profile for user: ${event.user} in channel: ${event.channel}`
    );

    cache.users[event.user].channel = event.channel;
    cache.users[event.user].latest_time = new Date().getTime();
    return res.status(200).send(`Update successful`);
  } else return res.status(400).send(`User profile already set.`);
});

app.listen(process.env.PORT ?? 3000, async () => {
  console.log(
    `🚀 Server ready at: ${process.env.HOST ?? "http://localhost:3000"}`
  );

  let { data, error } = await supabase.from("users").select();
  if (error) console.error(`Error while caching users: ${error}`);
  else
    data?.map(
      (user: any) =>
        (cache.users[user.user_id] = {
          id: user.user_id,
          channel: "",
          latest_time: 0,
          latest_delete_time: 0,
          token: user.slack_token,
        })
    );
});

async function handleInstantDelete(req: any, res: any, event: any, data: any) {
  if (!event.text.match(/[d*]/gi)) return res.status(404).send("not found ;-;");
  let messagesToDelete =
    event.text.match(/[d*]/gi).length > 5
      ? 5
      : event.text.match(/[d*]/gi).length;
  let messages: any[] = [];

  let history = await fetch(
    `https://slack.com/api/conversations.history?channel=${req.body.event.channel}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${data.token}`,
      },
    }
  ).then((res) => res.json());
  if (!history.ok) {
    console.error(history.error);
    return res
      .status(404)
      .send(`Channel history not available. ${history.error}`);
  }

  let slack = new WebClient(data.token);

  async function collectReplies(channel: string, thread_ts: string) {
    let replies: any[] = [];
    async function getNext(cursor: string | undefined) {
      const history = await slack.conversations.replies({
        channel: channel,
        ts: thread_ts,
        cursor: cursor,
      });
      replies.push(...(history.messages as any[]));
    }
    await getNext(undefined);
    return replies.reverse();
  }

  if (!event.thread_ts) {
    history.messages.map((i: any) =>
      i.user === event.user ? messages.push(i) : null
    );
    messages = messages.slice(0, messagesToDelete + 1);
  } else {
    messages = await collectReplies(event.channel, event.thread_ts);
    messages = messages
      .filter((i) => i.user === event.user)
      .slice(0, messagesToDelete + 1);
  }

  for (let message of messages) {
    try {
      await slack.chat.delete({
        channel: event.channel,
        ts: message.ts,
        as_user: true,
      });
    } catch (error) {
      console.log(error);
    }
  }
  cache.users[event.user].latest_delete_time = new Date().getTime();
  cache.users[event.user].latest_time = new Date().getTime();

  return res.status(200).send("Succesful");
}
