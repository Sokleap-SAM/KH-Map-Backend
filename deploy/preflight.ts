/**
 * Pre-deploy checks that don't need AWS or a running Docker daemon.
 *
 *   npx ts-node deploy/preflight.ts
 *
 * Catches the class of mistake that otherwise surfaces as a task that starts,
 * fails a health check, and rolls back ten minutes later: a required env var
 * missing from a task definition, a Service Connect name that doesn't match
 * the service publishing it, a port that disagrees with the target group, or
 * a placeholder nobody filled in.
 *
 * It does NOT prove the stack works — only that it is internally consistent.
 * Run the compose smoke test for behaviour.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { envValidationSchema } from '../src/config/env.validation';

const ROOT = path.join(__dirname, '..');
let failures = 0;
let warnings = 0;

const fail = (msg: string) => {
  console.log(`  FAIL  ${msg}`);
  failures++;
};
const warn = (msg: string) => {
  console.log(`  WARN  ${msg}`);
  warnings++;
};
const pass = (msg: string) => console.log(`  ok    ${msg}`);

const section = (name: string) => console.log(`\n${name}`);

interface ContainerDef {
  name: string;
  image: string;
  portMappings?: { name?: string; containerPort: number }[];
  environment?: { name: string; value: string }[];
  secrets?: { name: string; valueFrom: string }[];
  healthCheck?: { command: string[] };
  mountPoints?: { containerPath: string }[];
}
interface TaskDef {
  family: string;
  containerDefinitions: ContainerDef[];
  volumes?: unknown[];
}

const taskdefs: Record<string, TaskDef> = {};

// ── 1. Task definitions parse ────────────────────────────────────────────────
section('task definitions');
for (const file of fs.readdirSync(path.join(ROOT, 'deploy')).sort()) {
  if (!file.endsWith('.json')) continue;
  const full = path.join(ROOT, 'deploy', file);
  try {
    taskdefs[file] = JSON.parse(fs.readFileSync(full, 'utf8')) as TaskDef;
    pass(`${file} parses`);
  } catch (e) {
    fail(`${file} is not valid JSON: ${(e as Error).message}`);
  }
}

// ── 2. Env coverage for the API task ─────────────────────────────────────────
// Anything the schema marks required under NODE_ENV=production must reach the
// container as either plain config or a Secrets Manager reference.
section('API task env coverage (vs. env.validation.ts, NODE_ENV=production)');
const apiDef = taskdefs['taskdef-api.json'];
if (apiDef) {
  const api = apiDef.containerDefinitions.find((c) => c.name === 'api');
  const provided = new Set<string>([
    ...(api?.environment ?? []).map((e) => e.name),
    ...(api?.secrets ?? []).map((s) => s.name),
  ]);

  // Two separate questions, because a task definition holds real values for
  // `environment` but only ARNs for `secrets` — validating a secret's value
  // here would be meaningless.

  // (a) Presence. Ask the schema which keys it requires under production by
  // validating an almost-empty object and collecting the `any.required` misses.
  const { error: missing } = envValidationSchema.validate(
    { NODE_ENV: 'production' },
    { allowUnknown: true, abortEarly: false },
  );
  const required = (missing?.details ?? [])
    .filter((d) => d.type === 'any.required')
    .map((d) => String(d.path[0]));
  const absent = required.filter((k) => !provided.has(k));
  if (absent.length) absent.forEach((k) => fail(`${k} is required in production but not supplied`));
  else pass(`all ${required.length} production-required vars supplied (${provided.size} total)`);

  // (b) Validity of the values actually written in the file. Ignore
  // `any.required` here: secrets are legitimately absent from this object.
  const literal: Record<string, string> = { NODE_ENV: 'production' };
  (api?.environment ?? []).forEach((e) => (literal[e.name] = e.value));
  const { error: bad } = envValidationSchema.validate(literal, {
    allowUnknown: true,
    abortEarly: false,
  });
  const valueProblems = (bad?.details ?? []).filter((d) => d.type !== 'any.required');
  if (valueProblems.length) valueProblems.forEach((d) => fail(`bad value: ${d.message}`));
  else pass(`all ${(api?.environment ?? []).length} literal env values valid`);

  // Names the schema has never heard of are almost always typos.
  const known = new Set(Object.keys(envValidationSchema.describe().keys));
  for (const name of provided) {
    if (!known.has(name)) warn(`${name} is set but not in the env schema`);
  }
}

// ── 3. Service Connect wiring ────────────────────────────────────────────────
// Every khmap.local host referenced anywhere must be published by some task's
// portMappings, on the port it is referenced with.
section('service discovery (khmap.local)');
const published = new Map<string, number[]>();
for (const def of Object.values(taskdefs)) {
  for (const c of def.containerDefinitions) {
    for (const pm of c.portMappings ?? []) {
      const host = `${c.name}.khmap.local`;
      published.set(host, [...(published.get(host) ?? []), pm.containerPort]);
    }
  }
}
published.forEach((ports, host) =>
  pass(`${host} publishes ${ports.join(', ')}`),
);

const blob = JSON.stringify(taskdefs);
const referenced = [...blob.matchAll(/([a-z-]+)\.khmap\.local(?::(\d+))?/g)];
const seen = new Set<string>();
for (const [, host, port] of referenced) {
  const key = `${host}:${port ?? ''}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const full = `${host}.khmap.local`;
  const ports = published.get(full);
  if (!ports) {
    fail(`${full} is referenced but no task publishes it`);
  } else if (port && !ports.includes(Number(port))) {
    fail(`${full}:${port} referenced, but it publishes ${ports.join(', ')}`);
  } else {
    pass(`${full}${port ? `:${port}` : ''} resolves`);
  }
}

// Ports referenced via plain env values (REDIS_PORT, VALHALLA_PORT, ...) should
// agree with the published mapping too.
const apiEnv = Object.fromEntries(
  (apiDef?.containerDefinitions[0]?.environment ?? []).map((e) => [
    e.name,
    e.value,
  ]),
);
const portPairs: [string, string, string][] = [
  ['REDIS_HOST', 'REDIS_PORT', 'redis.khmap.local'],
  ['VALHALLA_HOST', 'VALHALLA_PORT', 'valhalla.khmap.local'],
];
for (const [hostKey, portKey, expectHost] of portPairs) {
  if (apiEnv[hostKey] !== expectHost) continue;
  const ports = published.get(expectHost) ?? [];
  if (!ports.includes(Number(apiEnv[portKey]))) {
    fail(`${hostKey}/${portKey}=${apiEnv[portKey]} but ${expectHost} publishes ${ports.join(', ')}`);
  } else {
    pass(`${hostKey}:${apiEnv[portKey]} matches published port`);
  }
}

// ── 4. Docker build inputs ───────────────────────────────────────────────────
section('docker build contexts');
const copySources: [string, string][] = [
  ['mosquitto/Dockerfile', 'mosquitto'],
  ['valhalla/Dockerfile', 'valhalla'],
];
for (const [dockerfile, ctx] of copySources) {
  const full = path.join(ROOT, dockerfile);
  if (!fs.existsSync(full)) {
    fail(`${dockerfile} missing`);
    continue;
  }
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  for (const line of lines) {
    const m = /^COPY\s+(?!--from)(\S+)\s+\S+/.exec(line.trim());
    if (!m) continue;
    const src = path.join(ROOT, ctx, m[1]);
    if (fs.existsSync(src)) pass(`${ctx}/${m[1]} present`);
    else fail(`${dockerfile}: COPY source ${m[1]} does not exist`);
  }
}

// ── 5. Unfilled placeholders ─────────────────────────────────────────────────
section('placeholders still to fill');
const scan = [
  'deploy/taskdef-api.json',
  'deploy/taskdef-valhalla.json',
  'deploy/taskdef-mosquitto.json',
  'deploy/taskdef-redis.json',
  '.github/workflows/deploy.yml',
];
const found = new Map<string, string[]>();
const templated: string[] = [];
for (const rel of scan) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  for (const [ph] of text.matchAll(/<[A-Z_]+>/g)) {
    found.set(ph, [...(found.get(ph) ?? []), rel]);
  }
  // IMAGE_TAG is NOT a warning: it is substituted at registration time, by CI
  // with the commit SHA. Baking a tag into the committed file would make that
  // substitution match nothing, so every later deploy would silently keep
  // shipping the old tag.
  if (text.includes('IMAGE_TAG')) templated.push(path.basename(rel));
}
if (found.size === 0) pass('none');
else
  found.forEach((files, ph) =>
    warn(`${ph} in ${[...new Set(files)].map((f) => path.basename(f)).join(', ')}`),
  );
if (templated.length) {
  pass(
    `IMAGE_TAG left as a template in ${[...new Set(templated)].join(', ')} ` +
      `— correct; substitute it at registration, do not commit a tag`,
  );
}

// ── 6. Local env file ────────────────────────────────────────────────────────
section('.env.production (used by the compose smoke test)');
const envFile = path.join(ROOT, '.env.production');
if (!fs.existsSync(envFile)) {
  warn('.env.production not found (fine if you only deploy via ECS)');
} else {
  const raw = fs.readFileSync(envFile, 'utf8');
  raw.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s+=/.test(l))
      fail(`line ${i + 1}: space before '=' — that key is never set`);
    if (l.trim() && !l.trim().startsWith('#') && !l.includes('='))
      fail(`line ${i + 1}: orphan line — a wrapped value was truncated above it`);
  });
  const parsed = dotenv.parse(raw) as Record<string, string>;
  const { error } = envValidationSchema.validate(
    { ...parsed, NODE_ENV: 'production' },
    { allowUnknown: true, abortEarly: false },
  );
  if (error) error.details.forEach((d) => fail(d.message));
  else pass('validates as NODE_ENV=production');
  for (const k of ['API_INTERNAL_HOST', 'API_INTERNAL_PORT'])
    if (!parsed[k]) fail(`${k} missing — the broker entrypoint exits without it`);
}

console.log(
  `\n${failures === 0 ? 'PREFLIGHT PASSED' : `PREFLIGHT FAILED: ${failures} problem(s)`}` +
    `${warnings ? `, ${warnings} warning(s)` : ''}`,
);
process.exit(failures === 0 ? 0 : 1);
