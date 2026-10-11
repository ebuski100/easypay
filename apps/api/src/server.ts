import { app } from "./app.js";
import { env, getAccessTokenSecret } from "./config/env.js";

getAccessTokenSecret();

app.listen(env.port, () => {
  console.log(`API listening on http://localhost:${env.port}`);
});
