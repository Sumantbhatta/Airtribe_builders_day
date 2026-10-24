import pg from "pg";

type Row = Record<string, any>;
type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: Row[] }>;

let queryImpl: QueryFn | null = null;
export let dbKind: "postgres" | "pglite" = "pglite";

const SCHEMA = `
create table if not exists learners (
  id serial primary key,
  name text not null,
  phone text unique,
  wa_number text,
  email text,
  consent boolean not null default false,
  token text unique not null,
  is_test boolean not null default false,
  goal text,
  motivation text,
  struggle text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists sessions (
  id serial primary key,
  learner_id int references learners(id),
  channel text not null,
  external_id text,
  stage text not null default 'DISCOVER',
  state jsonb not null default '{}',
  transcript jsonb not null default '[]',
  is_test boolean not null default false,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
create table if not exists attempts (
  id serial primary key,
  session_id int references sessions(id),
  learner_id int references learners(id),
  topic text,
  concept text not null,
  phase text not null,
  question_id text,
  question text,
  answer text,
  correct boolean not null,
  graded_by text not null default 'engine',
  created_at timestamptz not null default now()
);
create table if not exists profile_facts (
  id serial primary key,
  learner_id int not null references learners(id),
  topic text,
  concept text not null,
  status text not null,
  kind text not null,
  evidence text,
  source text not null default 'engine',
  learner_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (learner_id, concept)
);
create table if not exists outcomes (
  id serial primary key,
  session_id int references sessions(id),
  learner_id int references learners(id),
  channel text,
  topic text,
  gap_concept text,
  before_correct boolean,
  after_correct boolean,
  next_step text,
  summary text,
  created_at timestamptz not null default now()
);
create table if not exists payments (
  id serial primary key,
  learner_id int references learners(id),
  product text not null,
  amount_paise int not null,
  currency text not null default 'INR',
  status text not null,
  merchant_order_ref text unique,
  provider_order_id text,
  provider_payment_id text,
  raw jsonb not null default '{}',
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists agent_runs (
  id serial primary key,
  agent text not null,
  trigger text not null,
  status text not null,
  input jsonb not null default '{}',
  output jsonb not null default '{}',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create table if not exists approvals (
  id serial primary key,
  agent_run_id int references agent_runs(id),
  learner_id int references learners(id),
  kind text not null,
  draft text not null,
  final_text text,
  status text not null default 'pending',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists events (
  id bigserial primary key,
  type text not null,
  learner_id int,
  session_id int,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
`;

export async function initDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url) {
    // Render external URLs need TLS; internal (same-region) hostnames do not.
    const ssl = /\.render\.com|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
    const pool = new pg.Pool({ connectionString: url, ssl, max: 5 });
    queryImpl = (text, params) => pool.query(text, params as any[]);
    dbKind = "postgres";
    await pool.query(SCHEMA);
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(process.env.PGLITE_DIR || "./.pglite");
    queryImpl = async (text, params) => {
      const r = await db.query(text, params as any[]);
      return { rows: r.rows as Row[] };
    };
    dbKind = "pglite";
    await db.exec(SCHEMA);
  }
}

export async function q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!queryImpl) throw new Error("db not initialised");
  const r = await queryImpl(text, params);
  return r.rows as T[];
}

export async function one<T = Row>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

/** Append-only audit log. Every user-visible action writes one row. */
export async function logEvent(
  type: string,
  payload: Record<string, unknown> = {},
  learnerId?: number | null,
  sessionId?: number | null,
): Promise<void> {
  await q("insert into events (type, learner_id, session_id, payload) values ($1,$2,$3,$4)", [
    type,
    learnerId ?? null,
    sessionId ?? null,
    JSON.stringify(payload),
  ]);
}
