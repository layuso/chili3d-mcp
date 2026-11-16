# Remote Chili3D bridge deployment (personal homelab)

This is an opt-in adapter to the upstream `chili3d-mcp` project. It leaves
the upstream local STDIO MCP and loopback WebSocket behavior unchanged.

## Components

- Editor: `https://chilicad.home.ayusohaylock.com`, built from `layuso/chili3d`
- Bridge: a separate Coolify application built from `layuso/chili3d-mcp`
- Bridge endpoint: `https://chilicad-mcp.home.ayusohaylock.com`
- Remote MCP: `https://chilicad-mcp.home.ayusohaylock.com/mcp`

## Deploy the remote bridge

Create a separate Coolify application using Dockerfile build type:
- Git repo: `layuso/chili3d-mcp`
- Branch: `feature/remote-cad-bridge`
- Dockerfile: `Dockerfile.remote`
- Internal service port: `3000`
- Public domain: `https://chilicad-mcp.home.ayusohaylock.com` (HTTPS and WSS)
- Health path: `/health`

Set these **server-side** Coolify secrets:

- `CHILI_APP_ORIGIN=https://chilicad.home.ayusohaylock.com`
- `CHILI_PAIRING_TOKEN`: independent random secret, >= 32 characters
- `CHILI_MCP_BEARER_TOKEN`: another independent random secret, >= 32 characters

Never check credentials into Git. Never put either token in a URL or send it in chat.
Network TLS must terminate at the existing reverse proxy or Cloudflare Tunnel.
The WebSocket endpoint `/ws` accepts ONLY the configured editor Origin.
All MCP calls at `/mcp` require the MCP bearer credential.

## Pair a browser editor

Deploy `layuso/chili3d` from branch `feature/remote-cad-bridge` once the bridge
has passed its health check. Keep the old production deployment until then.

Open:

`https://chilicad.home.ayusohaylock.com/?bridge=wss%3A%2F%2Fchilicad-mcp.home.ayusohaylock.com%2Fws`

The page prompts for the `CHILI_PAIRING_TOKEN`, stores it only in the browser
session storage, and sends it as the first message over WSS. It sends the CAD
tool registry only after the bridge answers `authenticated`. Canceling the
prompt does not affect standalone CAD editing.

## Add to MetaMCP

- Transport: Streamable HTTP
- URL: `https://chilicad-mcp.home.ayusohaylock.com/mcp`
- Header: `Authorization: Bearer <CHILI_MCP_BEARER_TOKEN>`

The `chili3d_status`, `chili3d_list_tools`, and `chili3d_invoke` tools
are always available; actual modeling tools are also listed when a browser
has paired. If MetaMCP does not refresh the tool catalogue dynamically, use
`chili3d_list_tools` and `chili3d_invoke`.

## Limits

- One live browser document at a time (same as upstream).
- Leave the editor tab in the foreground for model execution.
- Browser IndexedDB remains the primary project persistence. Export model
  files as backups and do not assume the server saves the document.
- Model changes performed by an MCP agent and by a person share a document
  but are not isolated transactions across simultaneous agents.
- The public-facing MCP and WSS endpoints have bearer authentication;
  do not expose the underlying port directly to the Internet.
