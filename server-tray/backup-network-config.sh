#!/bin/bash
# backup-network-config.sh - Run this BEFORE any router setup
# Saves all network configs so you can instantly revert

set -e

BACKUP_DIR="$HOME/network-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "=== Backing up network configuration to $BACKUP_DIR ==="

# 1. Save current network interface state
echo "[1/8] Saving interface state..."
ip link show > "$BACKUP_DIR/ip-link.txt"
ip addr show > "$BACKUP_DIR/ip-addr.txt"
ip route > "$BACKUP_DIR/ip-route.txt"
iw dev 2>/dev/null > "$BACKUP_DIR/iw-dev.txt" || true

# 2. Backup netplan configs
echo "[2/8] Backing up netplan configs..."
if [ -d /etc/netplan ]; then
    sudo cp -r /etc/netplan "$BACKUP_DIR/netplan-backup"
fi

# 3. Backup dnsmasq configs
echo "[3/8] Backing up dnsmasq configs..."
if [ -f /etc/dnsmasq.conf ]; then
    sudo cp /etc/dnsmasq.conf "$BACKUP_DIR/dnsmasq.conf.bak"
fi
if [ -d /etc/dnsmasq.d ]; then
    sudo cp -r /etc/dnsmasq.d "$BACKUP_DIR/dnsmasq.d-backup"
fi

# 4. Backup hostapd configs
echo "[4/8] Backing up hostapd configs..."
if [ -f /etc/hostapd/hostapd.conf ]; then
    sudo cp /etc/hostapd/hostapd.conf "$BACKUP_DIR/hostapd.conf.bak"
fi

# 5. Backup sysctl settings
echo "[5/8] Backing up sysctl settings..."
sudo cp /etc/sysctl.conf "$BACKUP_DIR/sysctl.conf.bak"
if [ -d /etc/sysctl.d ]; then
    sudo cp -r /etc/sysctl.d "$BACKUP_DIR/sysctl.d-backup"
fi

# 6. Save iptables rules
echo "[6/8] Saving iptables rules..."
sudo iptables-save > "$BACKUP_DIR/iptables-rules.txt"
sudo ip6tables-save > "$BACKUP_DIR/ip6tables-rules.txt" 2>/dev/null || true

# 7. List of installed packages that might be router-related
echo "[7/8] Checking installed packages..."
dpkg -l | grep -E "(hostapd|dnsmasq|iptables|netfilter)" > "$BACKUP_DIR/router-packages.txt" || true

# 8. Save current services state
echo "[8/8] Saving service states..."
sudo systemctl list-unit-files | grep -E "(hostapd|dnsmasq)" > "$BACKUP_DIR/service-states.txt" || true

echo ""
echo "=== BACKUP COMPLETE ==="
echo "Backup location: $BACKUP_DIR"
echo ""
echo "To RESTORE everything back to this state, run:"
echo "  sudo bash $BACKUP_DIR/restore-network-config.sh"
echo ""

# Create the restore script inside the backup directory
cat > "$BACKUP_DIR/restore-network-config.sh" << 'RESTORE_EOF'
#!/bin/bash
# restore-network-config.sh - Instantly revert all network changes

BACKUP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== RESTORING network configuration from backup ==="

# 1. Stop router services
echo "[1/6] Stopping router services..."
sudo systemctl stop hostapd dnsmasq 2>/dev/null || true
sudo systemctl disable hostapd dnsmasq 2>/dev/null || true

# 2. Remove iptables NAT rules
echo "[2/6] Clearing iptables rules..."
sudo iptables -F
sudo iptables -t nat -F
sudo iptables -t mangle -F
sudo iptables -X

# 3. Disable IP forwarding
echo "[3/6] Disabling IP forwarding..."
sudo sysctl -w net.ipv4.ip_forward=0
echo "net.ipv4.ip_forward=0" | sudo tee /etc/sysctl.d/99-router-revert.conf

# 4. Restore netplan
echo "[4/6] Restoring netplan configs..."
if [ -d "$BACKUP_DIR/netplan-backup" ]; then
    sudo rm -rf /etc/netplan/*
    sudo cp -r "$BACKUP_DIR/netplan-backup"/* /etc/netplan/
fi

# 5. Remove dnsmasq configs we created
echo "[5/6] Removing dnsmasq router configs..."
if [ -f /etc/dnsmasq.d/router.conf ]; then
    sudo rm /etc/dnsmasq.d/router.conf
fi

# 6. Remove hostapd config
echo "[6/6] Removing hostapd config..."
if [ -f /etc/hostapd/hostapd.conf ]; then
    sudo rm /etc/hostapd/hostapd.conf
fi

# 7. Remove netplan WiFi config if it exists
if [ -f /etc/netplan/20-router-wifi.yaml ]; then
    sudo rm /etc/netplan/20-router-wifi.yaml
fi

# Apply restored netplan
echo "Applying restored network configuration..."
sudo netplan apply

echo ""
echo "=== RESTORE COMPLETE ==="
echo "All router settings removed. Original network config restored."
echo ""
echo "Check your services:"
echo "  curl https://ifconfig.me  # should show your IP"
echo "  sudo systemctl status cloudflared"
echo "  pgrep -c bitcoind  # check mining"
echo ""
RESTORE_EOF

chmod +x "$BACKUP_DIR/restore-network-config.sh"

# Also create an EMERGENCY revert script that doesn't need the backup dir
cat > "$HOME/EMERGENCY-REVERT-ROUTER.sh" << 'EMERGENCY_EOF'
#!/bin/bash
# EMERGENCY REVERT - Run this from anywhere if something breaks

echo "=== EMERGENCY REVERT ==="
echo "Stopping all router services and clearing rules..."

# Stop services
sudo systemctl stop hostapd dnsmasq 2>/dev/null || true
sudo systemctl disable hostapd dnsmasq 2>/dev/null || true

# Clear all iptables
sudo iptables -F
sudo iptables -t nat -F
sudo iptables -t mangle -F
sudo iptables -X

# Disable forwarding
sudo sysctl -w net.ipv4.ip_forward=0

# Remove configs we might have created
sudo rm -f /etc/dnsmasq.d/router.conf
sudo rm -f /etc/hostapd/hostapd.conf
sudo rm -f /etc/netplan/20-router-wifi.yaml
sudo rm -f /etc/sysctl.d/99-router.conf

# Try to apply whatever netplan exists
sudo netplan apply 2>/dev/null || true

echo "Done. Network should be back to previous state."
echo "If you're locked out, wait 2 minutes and netplan try will auto-revert."
EMERGENCY_EOF

chmod +x "$HOME/EMERGENCY-REVERT-ROUTER.sh"

echo "Emergency revert script also created at: $HOME/EMERGENCY-REVERT-ROUTER.sh"
