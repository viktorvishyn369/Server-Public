#!/bin/bash
# EMERGENCY-REVERT-ROUTER.sh - Run this if router setup breaks connectivity
# This instantly reverts all router/NAT settings back to previous state

echo "=== EMERGENCY REVERT ==="
echo "Stopping all router services and clearing rules..."

# 1. Stop router services
sudo systemctl stop hostapd dnsmasq 2>/dev/null || true
sudo systemctl disable hostapd dnsmasq 2>/dev/null || true

# 2. Clear all iptables rules (removes NAT)
sudo iptables -F
sudo iptables -t nat -F
sudo iptables -t mangle -F
sudo iptables -X

# 3. Disable IP forwarding
sudo sysctl -w net.ipv4.ip_forward=0

# 4. Remove router configs we created
sudo rm -f /etc/dnsmasq.d/router.conf
sudo rm -f /etc/hostapd/hostapd.conf
sudo rm -f /etc/netplan/20-router-lan.yaml
sudo rm -f /etc/sysctl.d/99-router.conf

# 5. Restore default dnsmasq.conf if needed
if [ ! -f /etc/dnsmasq.conf ]; then
    echo "# Default dnsmasq config" | sudo tee /etc/dnsmasq.conf >/dev/null
fi

# 6. Apply remaining netplan config
sudo netplan apply 2>/dev/null || true

echo ""
echo "=== RESTORE COMPLETE ==="
echo "Router settings removed. eno4 should regain DHCP IP from your old router."
echo ""
echo "Physical action needed:"
echo "  - Plug eno4 back into your old router (if you already moved cables)"
echo ""
echo "Check connectivity:"
echo "  ip addr show eno4     # Should show 192.168.x.x or similar"
echo "  curl https://ifconfig.me"
echo ""
