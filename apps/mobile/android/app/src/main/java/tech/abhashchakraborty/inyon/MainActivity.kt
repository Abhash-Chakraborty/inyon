package tech.abhashchakraborty.inyon

import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
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
        // the page's ground in the system's scheme, so nothing white shows between the splash and the first paint
        val night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val ground = Color.parseColor(if (night) "#1B1A18" else "#E9E8E4")
        window.setBackgroundDrawable(ColorDrawable(ground))
        bridge.webView.setBackgroundColor(ground)
        // a camera-capture photo input falls back to the gallery when the camera is refused
        bridge.webView.webChromeClient = InyonChromeClient(bridge)
    }
}
