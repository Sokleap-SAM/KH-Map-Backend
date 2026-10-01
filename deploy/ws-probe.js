#!/usr/bin/env node
/*
 * Probe one broker listener over WebSocket and report what it actually allowed.
 *
 * Needed because mosquitto_sub cannot test listeners 9001/9002: libmosquitto
 * speaks raw MQTT over TCP and never performs a WebSocket handshake, so it
 * fails with "A network protocol error occurred" regardless of what the broker
 * would have decided. Only 1883 is testable with it.
 *
 * mqtt.js is a production dependency of the API, so this runs inside that
 * container with no image change — pipe it in over stdin:
 *
 *   C="docker compose --env-file .env.production -f docker-compose.prod.yml"
 *   $C exec -T -e URL=ws://mqtt:9001 -e TOPIC='transit/#' api node < deploy/ws-probe.js
 *
 * IMPORTANT — a granted SUBACK does not mean data flows. Mosquitto is
 * permissive about wildcard SUBSCRIBE and then re-checks the `read` permission
 * on every message delivery, so an ACL-blocked client can be granted
 * `driver/#` and still receive nothing from it. To test what a client can
 * actually SEE, set WAIT_MS and publish to the topic from another connection;
 * the SUBACK alone answers a different, weaker question.
 *
 * Env:
 *   URL               ws://host:port                        (required)
 *   TOPIC             topic to subscribe to                 (default transit/#)
 *   WAIT_MS           listen this long after subscribing, reporting deliveries
 *   PUBLISH_TOPIC     publish instead of subscribing
 *   PUBLISH_PAYLOAD   payload for the above                 (default "probe")
 *   USERNAME/PASSWORD credentials
 *   USE_BACKEND_CREDS 1 = reuse MQTT_USERNAME/MQTT_PASSWORD already present in
 *                     the API container, so secrets stay off the command line
 *
 * Exit: 0 granted/published, 1 subscription denied, 2 connection refused,
 * 3 no answer.
 */
const mqtt = require('mqtt');

const url = process.env.URL;
const topic = process.env.TOPIC || 'transit/#';
const waitMs = Number(process.env.WAIT_MS || 0);
const publishTopic = process.env.PUBLISH_TOPIC;
const publishPayload = process.env.PUBLISH_PAYLOAD || 'probe';

const useBackend = process.env.USE_BACKEND_CREDS === '1';
const username = useBackend ? process.env.MQTT_USERNAME : process.env.USERNAME;
const password = useBackend ? process.env.MQTT_PASSWORD : process.env.PASSWORD;

if (!url) {
  console.error('set URL, e.g. URL=ws://mqtt:9001');
  process.exit(64);
}

const client = mqtt.connect(url, {
  connectTimeout: 4000,
  // One attempt only. The default reconnect loop would mask a refusal as a
  // hang, which is exactly the distinction this probe exists to make.
  reconnectPeriod: 0,
  username: username || undefined,
  password: password || undefined,
});

let finished = false;
const done = (code, msg) => {
  if (finished) return;
  finished = true;
  console.log(msg);
  client.end(true, () => process.exit(code));
};

const received = [];

client.on('message', (t) => {
  received.push(t);
});

client.on('connect', () => {
  console.log(
    `CONNECTED  ${url}${username ? ` as ${username}` : ' anonymously'}`,
  );

  if (publishTopic) {
    return client.publish(publishTopic, publishPayload, { qos: 0 }, (err) => {
      if (err) return done(1, `PUBLISH    refused for ${publishTopic}: ${err.message}`);
      return done(0, `PUBLISH    accepted for ${publishTopic}`);
    });
  }

  client.subscribe(topic, (err, granted) => {
    if (err) return done(1, `DENIED     subscribe to ${topic}: ${err.message}`);
    const codes = (granted || []).map((g) => g.qos);
    // 128 is the MQTT SUBACK failure code: the connection stands, the
    // subscription was refused by an ACL.
    if (codes.includes(128)) {
      return done(1, `DENIED     subscribe to ${topic} (SUBACK 128)`);
    }
    console.log(`GRANTED    subscribe to ${topic} (qos ${codes.join(',')})`);

    if (!waitMs) {
      return done(
        0,
        'NOTE       SUBACK only. Set WAIT_MS and publish from elsewhere to ' +
          'test whether messages are actually delivered.',
      );
    }

    console.log(`LISTENING  ${waitMs}ms for deliveries on ${topic} ...`);
    setTimeout(() => {
      if (received.length === 0) {
        return done(
          0,
          `DELIVERED  none — subscription granted but no message reached this ` +
            `client, so the read ACL is holding`,
        );
      }
      const unique = [...new Set(received)];
      return done(
        0,
        `DELIVERED  ${received.length} message(s) on: ${unique.join(', ')}`,
      );
    }, waitMs);
  });
});

client.on('error', (err) => {
  // Distinguish "the broker said no" from "we never reached a broker". Both
  // surface as an error event, but reporting a DNS or TCP failure as REFUSED
  // sends you looking at the auth model when the hostname simply does not
  // resolve yet.
  const code = err.code || '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return done(2, `NO DNS     ${url} does not resolve (${code})`);
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(code)) {
    return done(2, `UNREACHABLE ${url} (${code}) — listener or security group?`);
  }
  return done(2, `REFUSED    ${err.message}`);
});
setTimeout(() => done(3, 'NO ANSWER  broker did not respond'), waitMs + 10000);
