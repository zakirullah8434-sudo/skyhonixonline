package com.skyhonix.school;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends BridgeActivity {

    private static final int STORAGE_PERMISSION_REQUEST = 4412;

    private String pendingUrl;
    private String pendingUserAgent;
    private String pendingDisposition;
    private String pendingMime;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SaveToDownloadsPlugin.class);
        super.onCreate(savedInstanceState);
        installDownloadListener();
    }

    private void installDownloadListener() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        getBridge().getWebView().setDownloadListener(
                (url, userAgent, contentDisposition, mimeType, contentLength) ->
                        handleDownload(url, userAgent, contentDisposition, mimeType));
    }

    private void handleDownload(String url, String userAgent, String contentDisposition,
            String mimeType) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && ContextCompat.checkSelfPermission(this,
                        Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED) {
            pendingUrl = url;
            pendingUserAgent = userAgent;
            pendingDisposition = contentDisposition;
            pendingMime = mimeType;
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    STORAGE_PERMISSION_REQUEST);
            return;
        }
        performDownload(url, userAgent, contentDisposition, mimeType);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
            int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != STORAGE_PERMISSION_REQUEST) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted && pendingUrl != null) {
            performDownload(pendingUrl, pendingUserAgent, pendingDisposition, pendingMime);
        } else if (!granted) {
            showToast("Storage permission denied - file was NOT saved");
        }
        pendingUrl = null;
        pendingUserAgent = null;
        pendingDisposition = null;
        pendingMime = null;
    }

    private void performDownload(final String url, final String userAgent,
            final String contentDisposition, final String mimeType) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(true);
                if (userAgent != null && !userAgent.isEmpty()) {
                    conn.setRequestProperty("User-Agent", userAgent);
                }

                int code = conn.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) {
                    showToast("Download failed (HTTP " + code + ")");
                    return;
                }

                String mime = conn.getContentType();
                if (mime == null || mime.trim().isEmpty()) {
                    mime = mimeType;
                }
                if (mime == null || mime.trim().isEmpty()) {
                    mime = "application/pdf";
                }
                mime = mime.split(";")[0].trim();

                String name = DownloadsSaver.fileNameFromDisposition(
                        conn.getHeaderField("Content-Disposition"));
                if (name == null || name.trim().isEmpty()) {
                    name = DownloadsSaver.fileNameFromUrl(url);
                }

                String savedPath;
                try (InputStream in = conn.getInputStream()) {
                    savedPath = DownloadsSaver.save(getApplicationContext(), in, name, mime);
                }
                showToast("Saved: " + savedPath);
            } catch (Exception e) {
                showToast("Download failed: " + e.getMessage());
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }, "skyhonix-download").start();
    }

    private void showToast(final String message) {
        runOnUiThread(() ->
                Toast.makeText(getApplicationContext(), message, Toast.LENGTH_LONG).show());
    }
}
