package com.skyhonix.teacher;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Opens a URL OUTSIDE SkyHonix: the Social Media screen passes an optional
// Android package name (v74) so "Open Channel" / any video opens DIRECTLY
// inside the real social media app (TikTok, YouTube, Facebook, Instagram)
// instead of a browser tab or a WebView. window.open() is blocked inside
// the Capacitor WebView, so the URL is handed to Android here.
@CapacitorPlugin(name = "OpenExternal")
public class OpenExternalPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("No url provided");
            return;
        }
        url = url.trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("Only http(s) links can be opened");
            return;
        }

        // Optional hint: exact Android package of the target app.
        String pkg = call.getString("package");
        pkg = pkg == null ? "" : pkg.trim();

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (!pkg.isEmpty()) {
                intent.setPackage(pkg); // force the real social media app
            }
            try {
                getActivity().startActivity(intent);
            } catch (ActivityNotFoundException first) {
                if (pkg.isEmpty()) throw first;
                // App not installed (or cannot handle this URL) → generic
                // ACTION_VIEW: Android App Links open the app, otherwise the
                // default browser / app chooser takes over.
                Intent fallback = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(fallback);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open link: " + e.getMessage());
        }
    }
}
