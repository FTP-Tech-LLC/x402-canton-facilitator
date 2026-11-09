/** Entry point. Every knob is an env var so the service can be a plain
 *  container beside the participant, with no config file to drift. */
import { start } from "./server.js";

const adminAddress = process.env.CANTON_ADMIN_API_ADDRESS;
const authToken = process.env.TOPOLOGY_READER_TOKEN;
if (!adminAddress || !authToken) {
  console.error(
    "CANTON_ADMIN_API_ADDRESS and TOPOLOGY_READER_TOKEN are both required"
  );
  process.exit(1);
}
await start({
  adminAddress,
  authToken,
  ...(process.env.TOPOLOGY_READER_HOST
    ? { host: process.env.TOPOLOGY_READER_HOST }
    : {}),
  ...(process.env.TOPOLOGY_READER_PORT
    ? { port: Number(process.env.TOPOLOGY_READER_PORT) }
    : {}),
});
