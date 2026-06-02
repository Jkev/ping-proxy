# Ping Proxy — Despliegue en Debian (portal.digy.mx)

Guía del despliegue real en producción: `server.js` corriendo como servicio `systemd`
en el servidor Debian `portal.digy.mx` (IP interna `10.9.2.2/24`, detrás de NAT).

> **Contexto del servidor:** es un box de **producción ISP**. Ahí también corren
> Apache + php7.2-fpm (el portal), MariaDB, **freeradius (AAA PPPoE — NO tocar)**,
> nfcapd (NetFlow) y exim4. El despliegue va **aislado** en `/opt/ping-proxy` y como
> usuario propio; no toca ninguno de esos servicios.

## Resumen de la arquitectura

| Cosa | Valor |
|------|-------|
| Ruta | `/opt/ping-proxy/` |
| Usuario | `pingproxy` (system user, sin login) |
| Servicio | `systemd` → `ping-proxy.service` |
| Runtime | Node v21.7.3 / npm 10.5.0 (ya instalados en el server) |
| Puerto | `3001` — **solo interno** (no reenviado a internet por el NAT; alcanzable desde `10.9.2.0/24` y la red de gestión MikroTik) |
| Logs | `journalctl -u ping-proxy` |
| Zona horaria | `America/Mexico_City` (en el unit) |

## Acceso al servidor (desde Windows)

La llave es de **PuTTY** (`.ppk`), no de OpenSSH. Usar `plink`/`pscp` de PuTTY:

```powershell
$plink = "C:\Program Files\PuTTY\plink.exe"
$pscp  = "C:\Program Files\PuTTY\pscp.exe"
$key   = "C:\Users\kevin\Downloads\mario-priv.ppk"

& $plink -i $key -batch root@portal.digy.mx "uname -a"
```

> **Tip de quoting:** PowerShell rompe las comillas/paréntesis al pasar comandos
> multilínea a plink. Para scripts complejos, escribe un `.sh` local (con saltos de
> línea LF) y usa: `plink -i <key> -batch -m script.sh root@portal.digy.mx`.

## Instalación desde cero (cómo se montó)

### 1. Crear usuario de sistema

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin pingproxy
```

### 2. Subir el código

Sin git en el server; se transfieren solo los archivos del servicio con `pscp`:

```powershell
& $plink -i $key -batch root@portal.digy.mx "mkdir -p /opt/ping-proxy"
& $pscp  -i $key -batch server.js package.json package-lock.json `
    root@portal.digy.mx:/opt/ping-proxy/
```

### 3. Instalar dependencias

```bash
cd /opt/ping-proxy
npm ci --omit=dev          # routeros es JS puro, sin build nativo
```

### 4. Crear el `.env`

Archivo `/opt/ping-proxy/.env` (chmod 600, dueño `pingproxy`). El `server.js`
**solo** lee estas 8 variables:

```
PROXY_API_KEY=
MIKROTIK_USER=apipanel
MIKROTIK_PASSWORD=
MIKROTIK_PORT=8728
MAPA_REPORTES_API_URL=https://mapa-reportes-digy.vercel.app
MAPA_REPORTES_API_KEY=
SMARTOLT_URL=https://digynetworks.smartolt.com
SMARTOLT_API_KEY=
```

> Las viejas `SHEETBEST_API_URL` y `MIKROWISP_*` ya **no** las usa `server.js`.

```bash
chown pingproxy:pingproxy /opt/ping-proxy/.env
chmod 600 /opt/ping-proxy/.env
chown -R pingproxy:pingproxy /opt/ping-proxy
```

### 5. Instalar el servicio systemd

`/etc/systemd/system/ping-proxy.service`:

```ini
[Unit]
Description=Ping Proxy - monitoreo PPPoE MikroTik (DIGY)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pingproxy
Group=pingproxy
WorkingDirectory=/opt/ping-proxy
ExecStart=/usr/bin/node /opt/ping-proxy/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ping-proxy
Environment=NODE_ENV=production
Environment=TZ=America/Mexico_City
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now ping-proxy
```

## Verificación

```bash
systemctl is-active ping-proxy
curl -s http://127.0.0.1:3001/health

# Login real a un router (valida credenciales MikroTik + L2)
curl -s -X POST http://127.0.0.1:3001/ping \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -d '{"ipRouter":"10.2.1.120","clientIp":"10.0.0.1","pppUser":"test-noexiste"}'
```

Conectividad L2 a un router:

```bash
timeout 4 bash -c "echo > /dev/tcp/10.2.1.120/8728" && echo OK || echo FAIL
```

## Exposición pública (ngrok) — requerida por MapaReportes

`ping-proxy` escucha en `3001` **interno**, pero MapaReportes-Digy (Vercel) lo llama de
entrada (`/ping`, `/ppp/disconnect`, `/ont/reboot`, `/ppp/set-password`,
`/firewall/nat/*`). Para eso se expone con **ngrok** y un **dominio reservado fijo**:

- Binario: `/usr/local/bin/ngrok` (v3, instalado del tarball estático).
- Config: `/etc/ngrok/ngrok.yml` (chmod 600, dueño `pingproxy`, contiene el authtoken):
  ```yaml
  version: "2"
  authtoken: <NGROK_AUTHTOKEN>
  tunnels:
    ping-proxy:
      proto: http
      addr: 3001
      domain: precolourable-enzymatic-brigitte.ngrok-free.dev
  ```
- Servicio: `ngrok-ping-proxy.service` (systemd, `Requires=ping-proxy.service`, `enable --now`).
- URL pública: `https://precolourable-enzymatic-brigitte.ngrok-free.dev` → `localhost:3001`.

En **Vercel** (MapaReportes-Digy) configurar:
```
PING_PROXY_URL=https://precolourable-enzymatic-brigitte.ngrok-free.dev
PING_PROXY_API_KEY=<igual que PROXY_API_KEY del proxy>
```

> Tier free: dominio estático estable (no cambia). El interstitial de ngrok NO aparece
> para llamadas API (User-Agent no-browser), así que MapaReportes no necesita headers
> extra. Ojo con los límites de tráfico del plan free si el volumen crece.

Operación de ngrok:
```bash
systemctl status ngrok-ping-proxy
journalctl -u ngrok-ping-proxy -n 30 --no-pager
curl -s http://127.0.0.1:4040/api/requests/http   # inspector local de requests
```

## Operación

```bash
systemctl status ping-proxy
systemctl restart ping-proxy
systemctl stop ping-proxy
journalctl -u ping-proxy -f          # seguir logs en vivo
journalctl -u ping-proxy -n 100 --no-pager
```

## Actualizar el código

```powershell
& $pscp -i $key -batch server.js root@portal.digy.mx:/opt/ping-proxy/
# si cambiaron dependencias:
& $plink -i $key -batch root@portal.digy.mx "cd /opt/ping-proxy && npm ci --omit=dev"
& $plink -i $key -batch root@portal.digy.mx "systemctl restart ping-proxy"
```

## Notas importantes

- **Monitoreo horario:** el `server.js` programa un cron interno `0 * * * *` que llama
  a MapaReportes. **Solo debe correr una instancia** — si vuelve a levantarse el viejo
  proxy en Windows a la vez, habría doble escritura.
- **Migración desde Windows (2026-06-01):** se dio de baja el túnel Cloudflare
  `ping.digy.mx` (ya da NXDOMAIN). Asegurar que el proceso `node server.js` en la PC
  Windows esté detenido (su cron es saliente y no depende del túnel).
- **Exposición:** el 3001 NO está reenviado por el NAT; la entrada pública la da
  **ngrok** (ver sección arriba) hacia el dominio reservado fijo. No hay firewall de
  host configurado; no agregar reglas en este box sin necesidad (corre RADIUS).
