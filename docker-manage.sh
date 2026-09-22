#!/usr/bin/env bash
# docker-manage.sh - DeepSeek Gateway Docker Management CLI (Linux/macOS)
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ ! -f .env ] && [ -f .env.example ]; then
    cp .env.example .env
    echo "Created .env from .env.example"
fi

ACTION="${1:-status}"

case "$ACTION" in
    up)
        echo "Starting DeepSeek Gateway container in background..."
        docker compose up -d --build
        echo "Container started!"
        echo "OpenAI API: http://127.0.0.1:19728/v1/chat/completions"
        echo "Dashboard:  http://127.0.0.1:19728/panel/"
        ;;
    down)
        echo "Stopping DeepSeek Gateway container..."
        docker compose down
        echo "Container stopped."
        ;;
    restart)
        echo "Restarting DeepSeek Gateway container..."
        docker compose restart
        ;;
    build)
        echo "Rebuilding Docker image..."
        docker compose build --no-cache
        ;;
    status)
        echo "================ Container Status ================"
        docker compose ps
        echo "--------------------------------------------------"
        if curl -fsS http://127.0.0.1:19728/health >/dev/null 2>&1; then
            echo "Gateway Service: Healthy"
        else
            echo "Gateway Service: Not reachable"
        fi
        ;;
    logs)
        docker compose logs -f --tail 100
        ;;
    *)
        echo "Usage: $0 [up|down|restart|build|status|logs]"
        exit 1
        ;;
esac
