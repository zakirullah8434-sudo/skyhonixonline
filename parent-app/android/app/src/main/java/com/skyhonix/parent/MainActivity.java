package com.skyhonix.parent;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Registers the custom native plugins BEFORE the bridge boots so the
    // portal can call them immediately (OpenExternal: opening social media
    // links in the system browser).
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(OpenExternalPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // ---------------------------------------------------------------
    // Android hardware / gesture BACK button
    // ---------------------------------------------------------------
    // Capacitor ships no back handling at all, so without this override
    // EVERY back press finished the Activity and the app closed — even in
    // the middle of a section.
    //
    // The portal records its own navigation stack with history.pushState()
    // (public/js/section-history.js): dashboard -> section -> subsection,
    // one history entry per level. The WebView's history therefore IS the
    // app's navigation stack:
    //   * canGoBack() -> hand the press to the WebView; it fires popstate
    //     and the portal re-renders the previous section / subsection.
    //   * nothing left (the dashboard is the first entry) -> fall through
    //     to the default behaviour and close the app (never a logout).
    // ---------------------------------------------------------------
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        try {
            if (getBridge() != null) {
                WebView webView = getBridge().getWebView();
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
            }
        } catch (Exception ignored) {
            // A missing/broken WebView must never swallow the back press.
        }
        super.onBackPressed();
    }
}
