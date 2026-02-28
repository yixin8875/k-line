//go:build !darwin

package main

import "errors"

func showMacNotification(_ string, _ string, _ string) error {
	return errors.New("mac notification is only supported on darwin")
}
