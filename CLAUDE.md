# CLinear-Code Project Notes

## Sprite Environment

This project runs in a Sprite VM (https://sprites.dev/, https://docs.sprites.dev/).

### Key CLI Commands

**sprite-env** - Manage services within the sprite:
```bash
# List all services
sprite-env services list

# Start/stop/restart a service
sprite-env services start <name>
sprite-env services stop <name>
sprite-env services restart <name>

# Create a service with HTTP routing
sprite-env services create <name> --cmd <command> --args <args> --dir <path> --http-port <port>

# View service logs
cat /.sprite/logs/services/<name>.log
```

**sprite** - Manage sprites (VMs) from outside:
```bash
sprite create <name>      # Create new sprite
sprite list               # List sprites
sprite exec <cmd>         # Execute command in sprite
sprite checkpoint create  # Create checkpoint
sprite restore <id>       # Restore from checkpoint
```

### Current Service

The Linear webhook server runs as a sprite service:
- Name: `linear-webhook`
- Command: `cd /home/sprite/CLinear-Code && node dist/index.js`
- HTTP Port: 3000 (routed via sprite proxy)

### Log Files

Application logs are written to:
- `logs/clinear.log` - All logs
- `logs/clinear-error.log` - Errors only
- `logs/webhook.log` - Webhook-specific logs

Service logs from sprite-env:
- `/.sprite/logs/services/linear-webhook.log`

## Development

```bash
npm run build     # Compile TypeScript
sprite-env services restart linear-webhook  # Restart after changes
```
