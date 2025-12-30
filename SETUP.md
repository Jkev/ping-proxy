# Ping Proxy - Setup en Windows

## 1. Instalar en la PC interna de DIGY

Copiar la carpeta `ping-proxy` a la PC que tiene acceso a los routers.

```cmd
cd C:\ruta\a\ping-proxy
npm install
npm start
```

Deberias ver:
```
🚀 Ping Proxy corriendo en http://localhost:3001
```

## 2. Exponer a internet con Cloudflare Tunnel (GRATIS)

### Instalar cloudflared

1. Descargar: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
2. O con winget:
   ```cmd
   winget install Cloudflare.cloudflared
   ```

### Crear tunnel (una sola vez)

```cmd
cloudflared tunnel login
cloudflared tunnel create digy-ping
```

### Configurar tunnel

Crear archivo `config.yml` en `C:\Users\TU_USUARIO\.cloudflared\`:

```yaml
tunnel: digy-ping
credentials-file: C:\Users\TU_USUARIO\.cloudflared\<ID-DEL-TUNNEL>.json

ingress:
  - hostname: ping.digy.mx
    service: http://localhost:3001
  - service: http_status:404
```

### Configurar DNS en Cloudflare

```cmd
cloudflared tunnel route dns digy-ping ping.digy.mx
```

### Ejecutar tunnel

```cmd
cloudflared tunnel run digy-ping
```

## 3. Instalar como servicio Windows (opcional)

Para que inicie automaticamente:

```cmd
cloudflared service install
```

## 4. Probar

```bash
curl https://ping.digy.mx/health
```

## Alternativa: ngrok (mas facil, menos permanente)

Si no quieres configurar Cloudflare:

```cmd
npm install -g ngrok
ngrok http 3001
```

Te dara una URL como `https://abc123.ngrok.io` que puedes usar temporalmente.
