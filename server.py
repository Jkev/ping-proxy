from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os
import ssl

# Intentar cargar librería de RouterOS
try:
    import routeros_api
    ROUTEROS_AVAILABLE = True
except ImportError:
    ROUTEROS_AVAILABLE = False
    print("⚠️  Instala routeros-api: pip install routeros-api")

# Configuración
PORT = int(os.environ.get('PORT', 3001))
API_KEY = os.environ.get('PROXY_API_KEY', 'pachi')
MIKROTIK_USER = os.environ.get('MIKROTIK_USER', 'mario')
MIKROTIK_PASSWORD = os.environ.get('MIKROTIK_PASSWORD', '')
MIKROTIK_PORT = int(os.environ.get('MIKROTIK_PORT', 8728))


def ping_from_router(router_ip, target_ip):
    """Ejecuta ping desde un router MikroTik"""
    print(f"[Ping] Conectando a router {router_ip}:{MIKROTIK_PORT}...")
    print(f"[Ping] Usuario: {MIKROTIK_USER}")

    try:
        connection = routeros_api.RouterOsApiPool(
            router_ip,
            username=MIKROTIK_USER,
            password=MIKROTIK_PASSWORD,
            port=MIKROTIK_PORT,
            plaintext_login=True
        )
        api = connection.get_api()
        print(f"[Ping] Conexión exitosa, ejecutando ping a {target_ip}...")

        # Ejecutar ping
        ping = api.get_resource('/ping')
        result = ping.call('', {'address': target_ip, 'count': '3'})

        connection.disconnect()
        print(f"[Ping] Resultado: {result}")

        if result:
            received = 0
            total_time = 0

            for item in result:
                if 'time' in item:
                    received += 1
                    # Extraer tiempo en ms
                    time_str = item.get('time', '0ms')
                    time_val = int(''.join(filter(str.isdigit, time_str)) or 0)
                    total_time += time_val

            sent = 3
            packet_loss = ((sent - received) / sent) * 100
            avg_latency = round(total_time / received) if received > 0 else 0

            if received > 0:
                return {
                    'success': True,
                    'status': 'online',
                    'latency': avg_latency,
                    'packetLoss': packet_loss,
                    'clientIp': target_ip,
                    'message': f'{received}/{sent} paquetes recibidos, latencia: {avg_latency}ms'
                }
            else:
                return {
                    'success': True,
                    'status': 'offline',
                    'packetLoss': 100,
                    'clientIp': target_ip,
                    'message': 'No se recibieron respuestas (100% packet loss)'
                }

        return {
            'success': False,
            'status': 'error',
            'clientIp': target_ip,
            'message': 'No se obtuvieron resultados del ping'
        }

    except Exception as e:
        print(f"[Ping] Error: {e}")
        return {
            'success': False,
            'status': 'error',
            'clientIp': target_ip,
            'message': str(e)
        }


class ProxyHandler(BaseHTTPRequestHandler):
    def _send_response(self, status_code, data):
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            from datetime import datetime
            self._send_response(200, {
                'status': 'ok',
                'timestamp': datetime.utcnow().isoformat() + 'Z'
            })
        else:
            self._send_response(404, {'message': 'Not found'})

    def do_POST(self):
        if self.path == '/ping':
            # Verificar API key
            auth_header = self.headers.get('Authorization', '')
            if auth_header != f'Bearer {API_KEY}':
                self._send_response(401, {'success': False, 'message': 'Unauthorized'})
                return

            # Leer body
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode()

            try:
                data = json.loads(body)
                ip_router = data.get('ipRouter')
                client_ip = data.get('clientIp')

                if not ip_router or not client_ip:
                    self._send_response(400, {
                        'success': False,
                        'message': 'Faltan parámetros: ipRouter, clientIp'
                    })
                    return

                print(f"[Request] Ping desde {ip_router} hacia {client_ip}")

                if not ROUTEROS_AVAILABLE:
                    self._send_response(500, {
                        'success': False,
                        'message': 'routeros-api no instalado'
                    })
                    return

                result = ping_from_router(ip_router, client_ip)
                self._send_response(200, result)

            except json.JSONDecodeError:
                self._send_response(400, {'success': False, 'message': 'JSON inválido'})
            except Exception as e:
                self._send_response(500, {'success': False, 'message': str(e)})
        else:
            self._send_response(404, {'message': 'Not found'})

    def log_message(self, format, *args):
        print(f"[HTTP] {args[0]}")


def main():
    print(f"🚀 Ping Proxy (Python) corriendo en http://localhost:{PORT}")
    print(f"📡 Endpoints:")
    print(f"   GET  /health - Health check")
    print(f"   POST /ping   - Ejecutar ping (requiere Authorization header)")
    print(f"")
    print(f"⚙️  Configuración:")
    print(f"   API Key: {API_KEY[:4]}...")
    print(f"   MikroTik User: {MIKROTIK_USER}")
    print(f"   MikroTik Port: {MIKROTIK_PORT}")
    print()

    server = HTTPServer(('0.0.0.0', PORT), ProxyHandler)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Servidor detenido")
        server.shutdown()


if __name__ == '__main__':
    main()
