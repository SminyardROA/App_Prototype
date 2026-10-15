# ROA ReserveConnect chatbot prototype

Source-supported research across the member-approved ROA knowledge base, with a
VA-disability focus and support for military pay, benefits, and other library topics.

## Run

Use a current Node.js LTS release:

```sh
cd chatbot
npm ci
npm start
```

The server uses the hosting service's `PORT` environment variable (default 3000).
The preview is `/`; the health endpoint is `/health`.

## Render setup

- Root directory: `chatbot`
- Build command: `npm ci`
- Start command: `npm start`
- Configure `ANTHROPIC_API_KEY`, `PINECONE_API_KEY`, `VOYAGE_API_KEY`, and
  `SESSION_SECRET` securely in the hosting service, never in repository files.
- Consult [chatbot/DEPLOYMENT.md](chatbot/DEPLOYMENT.md) for optional features,
  production storage, origin controls, and privacy configuration.

The RAG index lives in Pinecone; this repository does not contain its documents,
provider credentials, or member conversations. The Susan Lukas Act is treated
as proposed legislation, not as an enacted benefit or presumption.

## Repository scope

This is a clean application snapshot. Replit workspace history, uploaded private
attachments, agent memory, credentials, runtime state, and generated reports are
intentionally excluded.
