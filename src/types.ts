interface SlackAuthFailed {
  ok: false;
  error: string;
}
interface SlackAuthSuccess {
  ok: true;
  app_id: String;
  authed_user: {
    id: string;
    access_token: string;
  };
}

export type SlackAuthResponse = SlackAuthFailed | SlackAuthSuccess;

export interface Cache {
  event_time: number;
  event_id: string;
  users: {
    [id: string]: {
      channel: string;
      latest_time: number;
      latest_delete_time: number;
      token: string;
      id: string;
      blacklist?: string[];
    };
  };
}
