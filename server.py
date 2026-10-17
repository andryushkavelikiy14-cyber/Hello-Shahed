import http.server
import socketserver
import os
import asyncio
import websockets
import json
import threading

HTTP_PORT = 8000
WS_PORT = 8001

# Хранилище игроков
players = {}

class GameServerHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def do_GET(self):
        if self.path == '/':
            self.path = '/index.html'
        return super().do_GET()

def run_http_server():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with socketserver.TCPServer(("", HTTP_PORT), GameServerHandler) as httpd:
        print(f"[HTTP] Сервер раздачи файлов запущен на порту {HTTP_PORT}")
        httpd.serve_forever()

async def handle_client(websocket, path):
    player_id = str(id(websocket))
    players[player_id] = {"x": 0, "y": 2, "z": 0, "rx": 0, "ry": 0, "rz": 0, "mode": "human"}
    print(f"[WS] Игрок {player_id} подключился. Всего: {len(players)}")
    
    try:
        async for message in websocket:
            data = json.loads(message)
            
            if data["type"] == "move":
                players[player_id].update({
                    "x": data["x"], "y": data["y"], "z": data["z"],
                    "rx": data["rx"], "ry": data["ry"], "rz": data["rz"],
                    "mode": data.get("mode", "human")
                })
            
            elif data["type"] == "shoot":
                await broadcast({"type": "shoot", "id": player_id})
            
            await broadcast({
                "type": "state",
                "players": {pid: p for pid, p in players.items() if pid != player_id}
            })
            
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        if player_id in players:
            del players[player_id]
        print(f"[WS] Игрок {player_id} отключился. Осталось: {len(players)}")

async def broadcast(message):
    if players:
        msg_str = json.dumps(message)
        await asyncio.gather(*[ws.send(msg_str) for ws in list(players.keys()) if ws != message.get("id")], return_exceptions=True)

async def run_ws_server():
    async with websockets.serve(handle_client, "0.0.0.0", WS_PORT):
        print(f"[WS] Игровой сервер WebSockets запущен на порту {WS_PORT}")
        await asyncio.Future()

def start_ws():
    asyncio.run(run_ws_server())

if __name__ == "__main__":
    threading.Thread(target=run_http_server, daemon=True).start()
    try:
        start_ws()
    except KeyboardInterrupt:
        print("\nСерверы остановлены.")