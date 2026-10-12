package tech.abhashchakraborty.inyon

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import tech.abhashchakraborty.inyon.device.InyonChromeClient
import tech.abhashchakraborty.inyon.device.InyonDevicePlugin
import tech.abhashchakraborty.inyon.ssh.InyonSshPlugin

class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(InyonSshPlugin::class.java)
        registerPlugin(InyonDevicePlugin::class.java)
        super.onCreate(savedInstanceState)
        // a camera-capture photo input falls back to the gallery when the camera is refused
        bridge.webView.webChromeClient = InyonChromeClient(bridge)
    }
}
