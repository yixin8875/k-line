//go:build darwin

package main

import wailsMac "github.com/wailsapp/wails/v2/pkg/mac"

func showMacNotification(title string, subtitle string, message string) error {
	return wailsMac.ShowNotification(title, subtitle, message, "default")
}
