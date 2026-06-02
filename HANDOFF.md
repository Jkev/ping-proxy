# Handoff — Migración de ping-proxy a Debian (portal.digy.mx)

**Fecha:** 2026-06-01
**Qué se hizo:** se migró el servicio `ping-proxy` desde la PC Windows (que lo exponía
como `ping.digy.mx` vía Cloudflare Tunnel) al servidor **Debian `portal.digy.mx`**, ahora
como servicios `systemd`, expuesto públicamente con **ngrok** para que MapaReportes-Digy
lo siga consumiendo.

---

## TL;DR para revisar

- ✅ `ping-proxy` corre en `/opt/ping-proxy` como servicio `systemd` (usuario `pingproxy`), puerto 3001 interno.
- ✅ `ngrok-ping-proxy` (otro servicio systemd) expone el 3001 al dominio fijo `https://precolourable-enzymatic-brigitte.ngrok-free.dev`.
- ✅ Verificado de punta a punta: `/health` y `/ping` (con login real a un MikroTik) responden por el dominio público.
- ✅ Token de la API rotado (ya no es `pachi`). El valor vive en el `.env` del server y debe coincidir con Vercel.
- ⏳ **PENDIENTE:** actualizar env en Vercel (ver abajo) y confirmar que el `node server.js` viejo de Windows esté detenido.

---

## Arquitectura actual

```
MapaReportes-Digy (Vercel)
   │  inbound: /ping, /ppp/disconnect, /ont/reboot,
   │           /ppp/set-password, /firewall/nat/*
   ▼
https://precolourable-enzymatic-brigitte.ngrok-free.dev   (ngrok, dominio fijo)
   ▼
ngrok-ping-proxy.service  →  localhost:3001
   ▼
ping-proxy.service (Node, /opt/ping-proxy)
   │  outbound: jala/actualiza tickets (cron 0 * * * *)
   ├─────────────────────────────►  MapaReportes API (Vercel)
   │  RouterOS API :8728 (L2, mismo switch)
   └─────────────────────────────►  MikroTik (10.x.x.x)
```

- **Box de PRODUCCIÓN ISP:** en el mismo Debian corren Apache+php7.2-fpm (el portal),
  MariaDB, **freeradius (AAA PPPoE — NO TOCAR/NO REINICIAR)**, nfcapd (NetFlow), exim4.
  El despliegue va aislado en `/opt/ping-proxy`; no se tocó ninguno de esos servicios.
- IP interna `10.9.2.2/24` (eth0), detrás de NAT. El 3001 **no** está reenviado por NAT;
  la entrada pública la da exclusivamente ngrok.

## Acceso al servidor

SSH como `root@portal.digy.mx` con llave **PuTTY** (`mario-priv.ppk`). Desde Windows usar
`plink`/`pscp` de PuTTY (OpenSSH no lee `.ppk`). Para comandos con comillas/multilínea,
escribir un `.sh` (LF) y usar `plink -batch -m script.sh` (PowerShell rompe el quoting).

## Servicios systemd

| Unit | Qué hace |
|------|----------|
| `ping-proxy.service` | Node `server.js`, `/opt/ping-proxy`, puerto 3001, usuario `pingproxy` |
| `ngrok-ping-proxy.service` | `ngrok` (binario en `/usr/local/bin`), config `/etc/ngrok/ngrok.yml` (600), túnel al dominio fijo |

```bash
systemctl status ping-proxy ngrok-ping-proxy
journalctl -u ping-proxy -n 100 --no-pager
journalctl -u ngrok-ping-proxy -n 30 --no-pager
curl -s http://127.0.0.1:4040/api/requests/http   # inspector de requests de ngrok
```

## Verificación (cómo reproducirla)

> ⚠️ **No probar el dominio ngrok desde Windows:** PowerShell/curl+schannel falla en la
> renegociación TLS de ngrok ("server closed abruptly"). Es bug del cliente Windows, NO
> del túnel. Probar **desde el server** (curl Linux) o desde Vercel.

```bash
# salud por el dominio público (desde el server)
curl -s https://precolourable-enzymatic-brigitte.ngrok-free.dev/health
# ping real (auth + login MikroTik). Usa el token actual del .env.
curl -s -X POST https://precolourable-enzymatic-brigitte.ngrok-free.dev/ping \
  -H "Content-Type: application/json" -H "Authorization: Bearer <PROXY_API_KEY>" \
  -d '{"ipRouter":"10.2.1.120","clientIp":"10.0.0.1","pppUser":"test-noexiste"}'
```

## Secretos / token

- `PROXY_API_KEY` se **rotó** el 2026-06-01 (ya no es `pachi`). El valor real está en
  `/opt/ping-proxy/.env` (chmod 600). **No se incluye en este repo a propósito.**
- En **Vercel** (MapaReportes-Digy), `PING_PROXY_API_KEY` debe ser **idéntico** a ese
  `PROXY_API_KEY`, y `PING_PROXY_URL` el dominio ngrok.

## Acciones PENDIENTES

1. **Vercel (MapaReportes-Digy)** → actualizar env y redeploy:
   - `PING_PROXY_URL = https://precolourable-enzymatic-brigitte.ngrok-free.dev`
   - `PING_PROXY_API_KEY = <nuevo PROXY_API_KEY>` (pedírselo a Kevin / leerlo del `.env`)
   - Hasta hacerlo, las acciones inbound de MapaReportes responden **401**.
2. **Windows** → confirmar que el viejo `node server.js` está detenido. Su cron horario es
   saliente (escribe a MapaReportes) y NO depende del túnel ya caído; si sigue vivo, habría
   doble monitoreo.

## Riesgos / cosas a vigilar

- **ngrok tier free:** dominio estable (no cambia), sin interstitial para llamadas API,
  pero con **límites de tráfico**. Si el volumen crece, pasar a plan pago.
- **Cron único:** solo debe existir UNA instancia corriendo el cron `0 * * * *`. Ver punto 2.
- **No tocar** Apache/MariaDB/**freeradius** en este box. No agregar reglas de firewall sin
  necesidad (no hay firewall de host configurado y corre RADIUS).

## Referencias en el repo

- `SETUP-debian.md` — guía de despliegue paso a paso (incluye ngrok y config de Vercel).
- `ping-proxy.service`, `ngrok-ping-proxy.service` — units systemd.
- `.claude/agents/ping-proxy-debian-ops.md` — agente experto en operación/infra (Debian).
- `.claude/agents/ping-proxy-mikrotik-agent.md` — agente experto en el código del servicio.
- `SETUP.md` — guía vieja de Windows (histórica, ya no es el despliegue de producción).
