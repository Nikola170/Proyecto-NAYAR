#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════╗
║         N A Y A R  ·  Sistema de Inteligencia Espacial   ║
║         Scanner RSSI + Zonas + ThingSpeak                ║
║                                                          ║
║  Archivo único: nayar.py                                 ║
║  Uso:  sudo python3 nayar.py                             ║
║                                                          ║
║  Requisitos:                                             ║
║    pip install scapy requests                            ║
║    Interfaz WiFi en modo monitor                         ║
╚══════════════════════════════════════════════════════════╝
"""

import time
import json
import signal
import logging
import sys
import os
import requests
from datetime import datetime
from pathlib import Path
from scapy.all import sniff, RadioTap, Dot11, Dot11ProbeReq


# ════════════════════════════════════════════════════════════
#   CONFIGURACIÓN  ←  EDITA AQUÍ TUS DATOS
# ════════════════════════════════════════════════════════════

# — ThingSpeak —————————————————————————————————————————————
THINGSPEAK_API_KEY  = "TU_API_KEY_AQUI"       # ← Pega tu Write API Key
THINGSPEAK_CHANNEL  = "TU_CHANNEL_ID_AQUI"    # ← ID del canal (solo número)
THINGSPEAK_URL      = "https://api.thingspeak.com/update"

# Campos del canal ThingSpeak (ajusta según los que hayas creado):
#   Field 1 → Total dispositivos activos
#   Field 2 → Dispositivos Zona A
#   Field 3 → Dispositivos Zona B
#   Field 4 → Dispositivos Zona C
#   Field 5 → Dispositivos Zona D
#   Field 6 → RSSI promedio global
#   Field 7 → % ocupación estimada
#   Field 8 → Alertas (0 = ok, 1 = zona sin señal, 2 = dispositivo nuevo)

# — Interfaz WiFi ——————————————————————————————————————————
INTERFACE      = "wlan0"    # Cambia a "wlan1" si usas adaptador USB externo

# — Ciclos de escaneo ——————————————————————————————————————
SCAN_SECONDS   = 20         # Segundos escuchando por ciclo
# ThingSpeak free permite 1 envío cada 15s mínimo — no bajar de 15
SEND_EVERY_N_CYCLES = 1     # Enviar a ThingSpeak cada N ciclos

# — Zonas RSSI ——————————————————————————————————————————————
# Calibra estos valores colocando el móvil en cada zona y midiendo el RSSI
ZONES = [
    {"id": "A", "name": "Zona A · Núcleo",     "rssi_min": -50,  "rssi_max":   0},
    {"id": "B", "name": "Zona B · Medio",      "rssi_min": -65,  "rssi_max": -51},
    {"id": "C", "name": "Zona C · Periferia",  "rssi_min": -75,  "rssi_max": -66},
    {"id": "D", "name": "Zona D · Límite",     "rssi_min": -100, "rssi_max": -76},
]

# — Filtros ————————————————————————————————————————————————
RSSI_MINIMO    = -90        # Ignorar señales más débiles
TIMEOUT_DEVICE = 120        # Segundos sin ver un dispositivo → marcarlo inactivo

# — Archivos locales ———————————————————————————————————————
DATA_FILE = "nayar_devices.json"
LOG_FILE  = "nayar.log"

# — Capacidad máxima del espacio (para % ocupación) ————————
MAX_CAPACITY = 20           # Número máximo de personas esperadas


# ════════════════════════════════════════════════════════════
#   LOGGING
# ════════════════════════════════════════════════════════════

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler()
    ]
)
log = logging.getLogger("NAYAR")


# ════════════════════════════════════════════════════════════
#   ALMACÉN EN MEMORIA
# ════════════════════════════════════════════════════════════

# { "AA:BB:CC:DD:EE:FF": { mac, rssi, rssi_max, rssi_min, count, first_seen, last_seen, zone_id } }
devices = {}
cycle_count = 0
alert_code  = 0   # 0=ok, 1=zona vacía inesperada, 2=nuevo dispositivo


# ════════════════════════════════════════════════════════════
#   FUNCIONES DE CAPTURA WIFI
# ════════════════════════════════════════════════════════════

def get_rssi(packet):
    """Extrae el valor RSSI del header RadioTap."""
    try:
        if packet.haslayer(RadioTap):
            return packet[RadioTap].dBm_AntSignal
    except Exception:
        pass
    return None


def get_mac(packet):
    """Extrae la MAC address de origen del paquete 802.11."""
    try:
        if packet.haslayer(Dot11):
            mac = packet[Dot11].addr2
            if mac and mac != "ff:ff:ff:ff:ff:ff":
                return mac.upper()
    except Exception:
        pass
    return None


def process_packet(packet):
    """
    Callback de Scapy — se ejecuta por cada paquete capturado.
    Solo procesa Probe Requests (paquetes emitidos por smartphones
    cuando buscan redes WiFi conocidas).
    """
    global alert_code

    # Solo Probe Requests — los smartphones los emiten constantemente
    if not packet.haslayer(Dot11ProbeReq):
        return

    mac  = get_mac(packet)
    rssi = get_rssi(packet)

    if not mac or rssi is None or rssi < RSSI_MINIMO:
        return

    now = datetime.now().isoformat()

    if mac not in devices:
        # Dispositivo nuevo
        devices[mac] = {
            "mac":        mac,
            "rssi":       rssi,
            "rssi_max":   rssi,
            "rssi_min":   rssi,
            "count":      1,
            "first_seen": now,
            "last_seen":  now,
            "zone_id":    None,
        }
        alert_code = 2
        log.info(f"NUEVO  {mac}  {rssi} dBm")
    else:
        d = devices[mac]
        d["rssi"]      = rssi
        d["rssi_max"]  = max(d["rssi_max"], rssi)
        d["rssi_min"]  = min(d["rssi_min"], rssi)
        d["count"]    += 1
        d["last_seen"] = now


# ════════════════════════════════════════════════════════════
#   FUNCIONES DE ZONAS
# ════════════════════════════════════════════════════════════

def assign_zone(rssi):
    """Devuelve el ID de zona según el RSSI."""
    for z in ZONES:
        if z["rssi_min"] <= rssi <= z["rssi_max"]:
            return z["id"]
    return "D"


def is_active(device):
    """True si el dispositivo fue visto en los últimos TIMEOUT_DEVICE segundos."""
    try:
        last = datetime.fromisoformat(device["last_seen"])
        return (datetime.now() - last).seconds < TIMEOUT_DEVICE
    except Exception:
        return False


def rssi_label(rssi):
    """Etiqueta visual del nivel de señal."""
    if rssi >= -50: return "████ FUERTE "
    if rssi >= -65: return "███░ MEDIO  "
    if rssi >= -75: return "██░░ DÉBIL  "
    return              "█░░░ MUY DÉB"


def compute_zone_stats():
    """
    Asigna zonas a los dispositivos activos y
    devuelve estadísticas por zona + métricas globales.
    """
    zone_counts = {z["id"]: 0 for z in ZONES}
    zone_rssi   = {z["id"]: [] for z in ZONES}
    active_devs = []

    for d in devices.values():
        if is_active(d):
            zone_id     = assign_zone(d["rssi"])
            d["zone_id"] = zone_id
            zone_counts[zone_id] += 1
            zone_rssi[zone_id].append(d["rssi"])
            active_devs.append(d)

    total_active = len(active_devs)
    all_rssi     = [d["rssi"] for d in active_devs]
    avg_rssi     = round(sum(all_rssi) / len(all_rssi), 1) if all_rssi else 0
    ocupacion    = min(100, round((total_active / MAX_CAPACITY) * 100))

    return {
        "total_active": total_active,
        "zone_A":       zone_counts["A"],
        "zone_B":       zone_counts["B"],
        "zone_C":       zone_counts["C"],
        "zone_D":       zone_counts["D"],
        "avg_rssi":     avg_rssi,
        "ocupacion":    ocupacion,
        "zone_rssi":    zone_rssi,
    }


# ════════════════════════════════════════════════════════════
#   THINGSPEAK
# ════════════════════════════════════════════════════════════

def send_thingspeak(stats):
    """
    Envía las métricas a ThingSpeak vía HTTP GET.
    ThingSpeak free: mínimo 15 segundos entre envíos.

    Campos enviados:
      field1 = total dispositivos activos
      field2 = dispositivos Zona A
      field3 = dispositivos Zona B
      field4 = dispositivos Zona C
      field5 = dispositivos Zona D
      field6 = RSSI promedio global
      field7 = % ocupación
      field8 = código de alerta
    """
    global alert_code

params = {
    "api_key": THINGSPEAK_API_KEY,
    "field1":  stats["avg_rssi"],                          # RSSI promedio
    "field2":  stats["total_active"],                      # Nº dispositivos
    "field3":  stats["ocupacion"],                         # Ocupación %
    "field4":  min([d["rssi"] for d in devices.values() if is_active(d)] or [0]),  # RSSI mín
    "field5":  max([d["rssi"] for d in devices.values() if is_active(d)] or [0]),  # RSSI máx
    "field6":  max(0, 100 - stats["ocupacion"]),           # Índice energético
    "field7":  sum(1 for z in ["A","B","C","D"] if stats[f"zone_{z}"] > 0),  # Zonas activas
    "field8":  alert_code,                                  # Alertas
}

    try:
        response = requests.get(
            THINGSPEAK_URL,
            params=params,
            timeout=10
        )

        if response.status_code == 200 and response.text != "0":
            log.info(f"ThingSpeak ✓  entry_id={response.text.strip()}  "
                     f"activos={stats['total_active']}  "
                     f"ocup={stats['ocupacion']}%")
            alert_code = 0   # Reset alerta tras envío exitoso
            return True
        else:
            log.warning(f"ThingSpeak respuesta inesperada: {response.status_code} → {response.text}")
            return False

    except requests.exceptions.ConnectionError:
        log.error("ThingSpeak ✗  Sin conexión a internet")
        return False
    except requests.exceptions.Timeout:
        log.error("ThingSpeak ✗  Timeout en la petición")
        return False
    except Exception as e:
        log.error(f"ThingSpeak ✗  Error inesperado: {e}")
        return False


# ════════════════════════════════════════════════════════════
#   GUARDADO LOCAL
# ════════════════════════════════════════════════════════════

def save_local(stats):
    """Guarda snapshot local en JSON por si hay cortes de internet."""
    output = {
        "timestamp": datetime.now().isoformat(),
        "stats":     stats,
        "devices":   list(devices.values()),
    }
    try:
        with open(DATA_FILE, "w") as f:
            json.dump(output, f, indent=2)
    except Exception as e:
        log.warning(f"Error guardando JSON local: {e}")


# ════════════════════════════════════════════════════════════
#   CONSOLA — RESUMEN VISUAL
# ════════════════════════════════════════════════════════════

def print_summary(stats):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"\n{'─'*58}")
    print(f"  NAYAR · Ciclo #{cycle_count} · {ts}")
    print(f"{'─'*58}")

    # Dispositivos detectados
    active = [d for d in devices.values() if is_active(d)]
    if not active:
        print("  Sin dispositivos activos.")
    else:
        sorted_devs = sorted(active, key=lambda d: d["rssi"], reverse=True)
        for d in sorted_devs:
            zona = d.get("zone_id") or "?"
            print(f"  {d['mac']}  {rssi_label(d['rssi'])}  "
                  f"{d['rssi']:>4} dBm  Z:{zona}  [{d['count']:>3}pkt]")

    # Resumen por zonas
    print(f"{'─'*58}")
    for z in ZONES:
        zid    = z["id"]
        count  = stats[f"zone_{zid}"]
        rssis  = stats["zone_rssi"][zid]
        avg    = f"{round(sum(rssis)/len(rssis))} dBm" if rssis else "  —  "
        dot    = "●" if count > 0 else "○"
        print(f"  {dot} {z['name']:<26}  {count:>2} dev   {avg}")

    print(f"{'─'*58}")
    print(f"  Activos: {stats['total_active']}  |  "
          f"Ocupación: {stats['ocupacion']}%  |  "
          f"RSSI avg: {stats['avg_rssi']} dBm")
    print(f"{'─'*58}\n")


# ════════════════════════════════════════════════════════════
#   GRACEFUL SHUTDOWN
# ════════════════════════════════════════════════════════════

def handle_exit(sig, frame):
    print("\n\n  NAYAR · Apagando sistema...")
    stats = compute_zone_stats()
    save_local(stats)
    log.info("Sistema NAYAR detenido correctamente.")
    sys.exit(0)

signal.signal(signal.SIGINT,  handle_exit)
signal.signal(signal.SIGTERM, handle_exit)


# ════════════════════════════════════════════════════════════
#   BANNER
# ════════════════════════════════════════════════════════════

def print_banner():
    print("""
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║          N A Y A R  ·  v1.0.0                            ║
║          Sistema de Inteligencia Espacial                ║
║                                                          ║
║          WiFi RSSI Sniffer + Zonas + ThingSpeak          ║
║          Sin cámaras · Privacidad total                  ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
""")


# ════════════════════════════════════════════════════════════
#   MAIN
# ════════════════════════════════════════════════════════════

def main():
    global cycle_count

    print_banner()

    # Verificar que corre como root
    if os.geteuid() != 0:
        print("  ERROR: Necesitas ejecutar con sudo")
        print("  → sudo python3 nayar.py\n")
        sys.exit(1)

    # Verificar API Key configurada
    if "TU_API_KEY" in THINGSPEAK_API_KEY:
        print("  AVISO: Configura tu THINGSPEAK_API_KEY en el archivo")
        print("  → Edita las líneas 44-45 con tu API Key y Channel ID\n")

    log.info(f"Interfaz : {INTERFACE}")
    log.info(f"Ciclo    : {SCAN_SECONDS}s")
    log.info(f"Envío TS : cada {SEND_EVERY_N_CYCLES} ciclo(s)")
    log.info("Presiona Ctrl+C para detener\n")

    while True:
        cycle_count += 1
        log.info(f"━━ CICLO #{cycle_count} — escaneando {SCAN_SECONDS}s...")

        # 1. ESCANEAR paquetes WiFi
        try:
            sniff(
                iface=INTERFACE,
                prn=process_packet,
                timeout=SCAN_SECONDS,
                store=0               # No acumula en RAM
            )
        except PermissionError:
            log.error("Sin permisos — ejecuta con: sudo python3 nayar.py")
            sys.exit(1)
        except OSError as e:
            log.error(f"Error de interfaz '{INTERFACE}': {e}")
            log.error("Activa el modo monitor:")
            log.error("  sudo ip link set wlan0 down")
            log.error("  sudo iw dev wlan0 set type monitor")
            log.error("  sudo ip link set wlan0 up")
            time.sleep(5)
            continue

        # 2. CALCULAR estadísticas de zonas
        stats = compute_zone_stats()

        # 3. MOSTRAR resumen en consola
        print_summary(stats)

        # 4. GUARDAR copia local
        save_local(stats)

        # 5. ENVIAR a ThingSpeak (cada N ciclos)
        if cycle_count % SEND_EVERY_N_CYCLES == 0:
            send_thingspeak(stats)


if __name__ == "__main__":
    main()
