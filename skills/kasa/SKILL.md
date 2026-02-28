---
name: Kasa Smart Home
description: Control TP-Link Kasa smart home devices (lights, plugs, switches) on the local network
---


# Kasa Smart Home Control

Control TP-Link Kasa smart devices on Burke's local network using the `kasa` CLI tool (python-kasa, installed via pipx).

## Commands

### Discover all devices
```bash
kasa discover 2>&1 | grep -E "^==|^Host:|^Device state:"
```

### Turn a device on/off
```bash
kasa --host <IP> on
kasa --host <IP> off
```

### Get device details
```bash
kasa --host <IP>
```

## Known Devices

| Name | IP | Type |
|---|---|---|
| Boys Bathroom Lights | 192.168.100.83 | HS210 |
| Drews Lights | 192.168.100.89 | HS200 |
| Dining Room Lights | 192.168.100.94 | HS200 |
| Can Lights | 192.168.100.51 | HS200 |
| Master Bedroom Fan | 192.168.100.85 | HS200 |
| Cades Lights | 192.168.100.68 | HS200 |
| Master Bedroom Lights | 192.168.100.56 | HS200 |
| Porch Lights | 192.168.100.78 | HS200 |
| Tree | 192.168.100.97 | EP10 |
| Upstairs Lights | 192.168.100.96 | HS210 |
| Master Closet Lights | 192.168.100.65 | HS200 |
| @ Sign | 192.168.100.59 | KL420L5 |
| Office Lights | 192.168.100.57 | HS200 |
| Desk LEDs | 192.168.100.60 | KL400L5 |
| Backyard Lights | 192.168.100.54 | HS200 |
| Driveway Lights | 192.168.100.52 | HS200 |
| Bryns Lights | 192.168.100.75 | HS200 |
| Laundry Room Lights | 192.168.100.55 | HS210 |
| Island Lights | 192.168.100.90 | HS210 |
| Foyer Light | 192.168.100.53 | HS210 |
| Table Lights | 192.168.100.86 | HS200 |
| Garage Lights | 192.168.100.58 | HS200 |

## Tips
- Device discovery takes ~10 seconds. Use the known devices table above for instant control.
- The KL420L5 (@ Sign) and KL400L5 (Desk LEDs) are light strips and may support brightness/color commands.
- All communication is local — no cloud account needed.
- If a device IP changes, re-run `kasa discover` to update.

