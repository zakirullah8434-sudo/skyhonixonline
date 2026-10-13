package com.skyhonix.school;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;

@CapacitorPlugin(name = "SaveToDownloads")
public class SaveToDownloadsPlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String data = call.getString("data");
        String fileName = call.getString("fileName", "document.pdf");
        if (data == null || data.isEmpty()) {
            call.reject("No file data provided");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("Invalid file data", e);
            return;
        }

        try {
            String savedPath = DownloadsSaver.save(getContext(),
                    new ByteArrayInputStream(bytes), fileName, "application/pdf");
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("path", savedPath);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not save file: " + e.getMessage(), e);
        }
    }
}
