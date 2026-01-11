# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Descripción del Proyecto

Servicio proxy para monitorear conectividad de clientes verificando sesiones PPPoE en routers MikroTik. Construido para DIGY (México) para rastrear el estado online/offline de clientes. Se integra con SheetBest (API de Google Sheets) para gestión de tickets y persistencia de estados.

**Nota**: Este servicio NO ejecuta ping ICMP. Determina el estado del cliente basándose en si tiene una sesión PPPoE activa.

## Comandos

```bash
# Instalar dependencias
npm install

# Iniciar servidor (puerto 3001)
npm start

# Alternativa en Python
pip install -r requirements.txt
python server.py
```

## Arquitectura

### Componentes Principales (server.js)

- **Servidor HTTP** (puerto 3001): API REST con autenticación Bearer token
- **Integración RouterOS**: Conexión directa a routers MikroTik vía librería `routeros`
- **Monitoreo Programado**: node-cron ejecuta ciclo de monitoreo en el minuto 0 de cada hora

### Funciones Clave

| Función | Líneas | Propósito |
|---------|--------|-----------|
| `getClientStatus` | 191-271 | Verifica sesión PPPoE activa, retorna status online/offline |
| `checkActivePPPoE` | 52-87 | Verifica sesiones PPPoE, detecta discrepancias de IP |
| `getConnectionInfo` | 89-181 | Consulta estadísticas de interfaz (uptime, rxMB, txMB, link-downs) |
| `runMonitoringCycle` | 323-432 | Obtiene tickets de SheetBest, verifica estado PPPoE de cada uno, actualiza |

### Endpoints de la API

- `GET /health` - Health check
- `POST /ping` - Verificar estado PPPoE (requiere Bearer token)
- `POST /monitor/run` - Disparar monitoreo manual (requiere Bearer token)

### Flujo de Datos

1. SheetBest API → Obtener reportes activos
2. Por cada ticket → Verificar sesión PPPoE en el router MikroTik
3. Recolectar resultados (status online/offline, uptime, datos rx/tx)
4. Actualizar SheetBest con historial de monitoreo

## Variables de Entorno

```
PROXY_API_KEY          # Bearer token para autenticación
MIKROTIK_USER          # Usuario MikroTik (default: 'mario')
MIKROTIK_PASSWORD      # Contraseña MikroTik
MIKROTIK_PORT          # Puerto API MikroTik (default: 8728)
SHEETBEST_API_URL      # Endpoint de Google Sheets API
```

## Notas Técnicas

- **Timeouts**: Conexión al router 15s
- **Detección de estado**: Basado en sesión PPPoE activa (NO usa ping ICMP)
- **Zona horaria**: America/Mexico_City para todos los timestamps
- **Búsqueda de interfaz**: Intenta formatos `<pppoe-user>` y `pppoe-user`
- **Parseo de fechas MikroTik**: Maneja `dec/30/2025 14:30:00` y `2025-12-30 14:30:00`
- **Delay de 500ms** entre verificaciones durante ciclo de monitoreo
- **Requiere pppUser**: Sin usuario PPPoE, retorna `status: 'no_monitoreable'`

## Despliegue

Corre en Windows, expuesto vía Cloudflare Tunnel a `ping.digy.mx`. Ver SETUP.md para instrucciones detalladas de despliegue.
