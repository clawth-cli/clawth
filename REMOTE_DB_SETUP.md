# Remote Database Setup for Clawth

This document explains how to set up a REST API backend compatible with Clawth's remote database mode. Follow this to deploy your own server that Clawth can use instead of a local SQLite database.

## Overview

Clawth expects a REST API that follows the [PostgREST](https://postgrest.org) convention:

- Each table is exposed as an endpoint: `GET /credentials`, `POST /credentials`, etc.
- Filtering uses query parameters: `?agent_id=eq.myagent&service=eq.github`
- Authentication uses a JWT Bearer token in the `Authorization` header
- Responses are JSON arrays of row objects with snake_case keys
- Inserts/updates return the affected rows when `Prefer: return=representation` is set

You can use PostgREST directly on top of PostgreSQL, or build a compatible API in any language/framework.

## Database Schema

Create these tables exactly. Column names and types must match — Clawth sends and expects snake_case keys.

```sql
-- Core credential storage
-- Encrypted values are opaque base64 strings — the server never decrypts them
CREATE TABLE credentials (
    id            SERIAL PRIMARY KEY,
    agent_id      TEXT NOT NULL DEFAULT 'default',
    service       TEXT NOT NULL,
    type          TEXT NOT NULL,
    inject_method TEXT NOT NULL DEFAULT 'header',
    inject_name   TEXT NOT NULL,
    inject_template TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    iv            TEXT NOT NULL,
    auth_tag      TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE(agent_id, service)
);

-- URL glob patterns linked to credentials
CREATE TABLE url_patterns (
    id            SERIAL PRIMARY KEY,
    credential_id INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    pattern       TEXT NOT NULL,
    priority      INTEGER NOT NULL DEFAULT 0
);

-- OAuth2 token metadata (encrypted client secrets and cached tokens)
CREATE TABLE oauth_metadata (
    id                       SERIAL PRIMARY KEY,
    credential_id            INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    token_url                TEXT NOT NULL,
    authorize_url            TEXT,
    encrypted_client_id      TEXT NOT NULL,
    client_id_iv             TEXT NOT NULL,
    client_id_auth_tag       TEXT NOT NULL,
    client_id_salt           TEXT NOT NULL,
    encrypted_client_secret  TEXT,
    client_secret_iv         TEXT,
    client_secret_auth_tag   TEXT,
    client_secret_salt       TEXT,
    scopes                   TEXT,
    use_pkce                 INTEGER NOT NULL DEFAULT 0,
    encrypted_access_token   TEXT,
    access_token_iv          TEXT,
    access_token_auth_tag    TEXT,
    access_token_salt        TEXT,
    encrypted_refresh_token  TEXT,
    refresh_token_iv         TEXT,
    refresh_token_auth_tag   TEXT,
    refresh_token_salt       TEXT,
    expires_at               INTEGER
);

-- JWT signing metadata
CREATE TABLE jwt_metadata (
    id              SERIAL PRIMARY KEY,
    credential_id   INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    algorithm       TEXT NOT NULL DEFAULT 'RS256',
    issuer          TEXT,
    audience        TEXT,
    expiry_seconds  INTEGER NOT NULL DEFAULT 3600,
    custom_claims   TEXT
);

-- AWS SigV4 metadata
CREATE TABLE aws_metadata (
    id                      SERIAL PRIMARY KEY,
    credential_id           INTEGER NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    region                  TEXT NOT NULL,
    aws_service             TEXT NOT NULL,
    encrypted_session_token TEXT,
    session_token_iv        TEXT,
    session_token_auth_tag  TEXT,
    session_token_salt      TEXT
);

-- Key-value store for passphrase hashes and config
CREATE TABLE db_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Audit log (append-only)
CREATE TABLE audit_log (
    id          SERIAL PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    service     TEXT NOT NULL,
    url         TEXT NOT NULL,
    method      TEXT NOT NULL,
    status_code INTEGER,
    timestamp   INTEGER NOT NULL
);
```

## API Endpoints

Clawth makes the following HTTP requests. Your API must handle all of them.

### Authentication

Every request includes:
```
Authorization: Bearer <jwt>
Content-Type: application/json
Accept: application/json
```

### SELECT — `GET /<table>?<filters>`

Filters use PostgREST syntax:

| Operator | Example | Meaning |
|---|---|---|
| `eq` | `?agent_id=eq.myagent` | Exact match |
| `in` | `?credential_id=in.(1,2,3)` | In list |

Optional query parameters:
- `limit=N` — Limit number of rows
- `order=column.desc` — Sort order

**Response**: JSON array of row objects.

```
GET /credentials?agent_id=eq.myagent&service=eq.github&limit=1

200 OK
[
  {
    "id": 1,
    "agent_id": "myagent",
    "service": "github",
    "type": "bearer",
    "inject_method": "header",
    "inject_name": "Authorization",
    "inject_template": "Bearer {token}",
    "encrypted_value": "base64...",
    "iv": "base64...",
    "auth_tag": "base64...",
    "salt": "base64...",
    "created_at": 1710000000,
    "updated_at": 1710000000
  }
]
```

### INSERT — `POST /<table>`

**Request header**: `Prefer: return=representation`
**Request body**: JSON object with column values.
**Response**: JSON array containing the inserted row (with server-generated `id`).

```
POST /credentials
Prefer: return=representation

{
  "agent_id": "myagent",
  "service": "github",
  "type": "bearer",
  ...
}

201 Created
[{ "id": 42, "agent_id": "myagent", "service": "github", ... }]
```

### UPDATE — `PATCH /<table>?<filters>`

**Request header**: `Prefer: return=representation`
**Request body**: JSON object with columns to update (partial).
**Response**: JSON array of updated rows.

```
PATCH /credentials?agent_id=eq.myagent&service=eq.github
Prefer: return=representation

{
  "encrypted_value": "new_base64...",
  "iv": "new_base64...",
  "auth_tag": "new_base64...",
  "salt": "new_base64...",
  "updated_at": 1710001000
}

200 OK
[{ "id": 42, ... }]
```

### DELETE — `DELETE /<table>?<filters>`

```
DELETE /url_patterns?credential_id=eq.42

204 No Content
```

### UPSERT — `POST /<table>` with merge preference

Used for `db_meta` (key-value store). If the row exists, update it; otherwise insert.

**Request header**: `Prefer: return=representation,resolution=merge-duplicates`

```
POST /db_meta
Prefer: return=representation,resolution=merge-duplicates

{ "key": "passphrase_verify_hash:myagent", "value": "base64..." }

200 OK
[{ "key": "passphrase_verify_hash:myagent", "value": "base64..." }]
```

## Queries Clawth Makes

Here is every query pattern Clawth sends, for reference when testing your implementation:

```
# List credentials for an agent
GET /credentials?agent_id=eq.{agent}

# Get a specific credential
GET /credentials?agent_id=eq.{agent}&service=eq.{service}&limit=1

# Get URL patterns for credentials
GET /url_patterns?credential_id=in.({id1},{id2},{id3})

# Get/set metadata (passphrase hash, version)
GET /db_meta?key=eq.{key}&limit=1
POST /db_meta  (with merge-duplicates Prefer header)

# Insert a credential
POST /credentials

# Insert URL patterns
POST /url_patterns

# Update credential secret
PATCH /credentials?agent_id=eq.{agent}&service=eq.{service}

# Delete credential and related data
DELETE /url_patterns?credential_id=eq.{id}
DELETE /oauth_metadata?credential_id=eq.{id}
DELETE /jwt_metadata?credential_id=eq.{id}
DELETE /aws_metadata?credential_id=eq.{id}
DELETE /credentials?id=eq.{id}

# Insert/read metadata tables
POST /oauth_metadata
GET /oauth_metadata?credential_id=eq.{id}&limit=1
PATCH /oauth_metadata?credential_id=eq.{id}
POST /jwt_metadata
GET /jwt_metadata?credential_id=eq.{id}&limit=1
POST /aws_metadata
GET /aws_metadata?credential_id=eq.{id}&limit=1

# Audit log
POST /audit_log
GET /audit_log?agent_id=eq.{agent}&limit={n}&order=timestamp.desc
```

## Security Notes

1. **The server never sees plaintext secrets.** All `encrypted_*`, `iv`, `auth_tag`, and `salt` columns contain opaque base64 data encrypted client-side by Clawth. The server just stores and returns them.

2. **Authenticate every request.** Validate the JWT on every request. A good practice is to encode the `agent_id` in the JWT claims and add a PostgreSQL row-level security (RLS) policy so agents can only access their own rows.

3. **Use HTTPS.** Even though secrets are encrypted, the JWT token and metadata (service names, URL patterns) travel in plaintext over the wire.

4. **Restrict CORS** if your API is web-accessible. Clawth calls from server-side (Node/Bun), not browsers, so CORS headers are not required.

## Quick Start with PostgREST

The fastest way to deploy a compatible backend:

```bash
# 1. Create a PostgreSQL database and run the schema above

# 2. Install PostgREST
# https://postgrest.org/en/stable/install.html

# 3. Create a config file (postgrest.conf)
db-uri = "postgres://user:pass@localhost:5432/clawth"
db-schemas = "public"
db-anon-role = "clawth_user"
jwt-secret = "your-jwt-secret-at-least-32-chars-long"

# 4. Start PostgREST
postgrest postgrest.conf

# 5. Generate a JWT (example using node)
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({ role: 'clawth_user' }, 'your-jwt-secret-at-least-32-chars-long');
console.log(token);
"

# 6. Connect Clawth
bunx clawth setup --remote http://localhost:3000 --remote-jwt "<token>"
```

## Testing Your Implementation

After deploying, verify with:

```bash
# Setup should succeed
bunx clawth setup --remote https://your-api.com --remote-jwt "<token>" --passphrase "test"

# These should all work
bunx clawth set github --type bearer --pattern "*.github.com" --secret "test-token"
bunx clawth list
bunx clawth which api.github.com
bunx clawth delete github
bunx clawth status
```
