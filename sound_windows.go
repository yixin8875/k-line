//go:build windows

package main

import (
	"errors"
	"syscall"
)

var (
	user32ProcMessageBeep = syscall.NewLazyDLL("user32.dll").NewProc("MessageBeep")
)

func playNativeAlertSound() error {
	// 0xFFFFFFFF asks Windows to use the simple default beep.
	const simpleBeepType = ^uintptr(0)
	ret, _, callErr := user32ProcMessageBeep.Call(simpleBeepType)
	if ret != 0 {
		return nil
	}
	if callErr != syscall.Errno(0) {
		return callErr
	}
	return errors.New("MessageBeep returned 0")
}
