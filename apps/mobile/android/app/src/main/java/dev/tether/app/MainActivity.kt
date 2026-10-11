package dev.tether.app

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import dev.tether.app.device.TetherChromeClient
import dev.tether.app.device.TetherDevicePlugin
import dev.tether.app.ssh.TetherSshPlugin

class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TetherSshPlugin::class.java)
        registerPlugin(TetherDevicePlugin::class.java)
        super.onCreate(savedInstanceState)
        // a camera-capture photo input falls back to the gallery when the camera is refused
        bridge.webView.webChromeClient = TetherChromeClient(bridge)
    }
}
