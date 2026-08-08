PORT ?= 8080
BIND ?= 0.0.0.0

.PHONY: start start-lan tailscale test help

help:
	@echo "Innercast commands"
	@echo "  make start PORT=8080       Serve on all network interfaces"
	@echo "  make start BIND=127.0.0.1  Serve only on this Mac"
	@echo "  make start-lan PORT=8080   Alias for serving on all network interfaces"
	@echo "  make tailscale PORT=8080   Serve privately over trusted Tailscale HTTPS"
	@echo "  make test PORT=8080        Serve the browser test page"

start:
	python3 -m http.server $(PORT) --bind $(BIND)

start-lan:
	python3 -m http.server $(PORT) --bind 0.0.0.0

tailscale:
	@command -v tailscale >/dev/null || { echo "Tailscale CLI was not found. Install or update Tailscale first."; exit 1; }
	@set -eu; \
	python3 -m http.server $(PORT) --bind 127.0.0.1 & \
	innercast_server_pid=$$!; \
	trap 'kill $$innercast_server_pid 2>/dev/null || true' EXIT INT TERM; \
	echo "Starting private Tailscale HTTPS for Innercast…"; \
	tailscale serve $(PORT)

test:
	@echo "Open http://127.0.0.1:$(PORT)/tests/ after the server starts."
	python3 -m http.server $(PORT) --bind 127.0.0.1
