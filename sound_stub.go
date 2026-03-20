//go:build !windows

package main

func playNativeAlertSound() error {
	return nil
}
