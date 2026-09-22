#!/bin/bash

# Simple runner script for testing Balatro Mobile Maker locally.
# It starts a local python webserver on port 8000.

PORT=8000

echo "=================================================="
echo "Starting Lovely Mobile Maker Local Web Server..."
echo "Open your browser and navigate to:"
echo "    http://localhost:$PORT"
echo "=================================================="
echo "Press Ctrl+C to stop the server."
echo ""

python3 -m http.server $PORT
