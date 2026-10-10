package dev.tether.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import dev.tether.app.device.TetherDevicePlugin;
import dev.tether.app.ssh.TetherSshPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TetherSshPlugin.class);
        registerPlugin(TetherDevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
