package com.skyhonix.school;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Base64;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Saves a base64-encoded file directly into the public Downloads folder
 * (Downloads/SkyHonix/...) so the user can always find and open it in the
 * Files app.
 *
 * - Android 10+ (API 29): MediaStore.Downloads — no permissions required
 * - Android 9 and below: direct write + media scan (WRITE_EXTERNAL_STORAGE)
 */
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

        // Sanitise the filename (no path traversal)
        fileName = fileName.replace("/", "_").replace("\\", "_").replace("..", "_");
        if (!fileName.toLowerCase().endsWith(".pdf")) {
            fileName = fileName + ".pdf";
        }

        try {
            String savedPath;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                savedPath = saveWithMediaStore(fileName, bytes);
            } else {
                savedPath = saveLegacy(fileName, bytes);
            }

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("path", savedPath);
            ret.put("fileName", fileName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not save file: " + e.getMessage(), e);
        }
    }

    private String saveWithMediaStore(String fileName, byte[] bytes) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS + File.separator + "SkyHonix");

        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new Exception("MediaStore insert failed");
        }

        try (OutputStream os = resolver.openOutputStream(uri)) {
            if (os == null) {
                throw new Exception("Could not open output stream");
            }
            os.write(bytes);
            os.flush();
        }

        return Environment.DIRECTORY_DOWNLOADS + "/SkyHonix/" + fileName;
    }

    private String saveLegacy(String fileName, byte[] bytes) throws Exception {
        File dir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                "SkyHonix");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new Exception("Could not create Downloads/SkyHonix folder");
        }

        File out = new File(dir, fileName);
        if (out.exists()) {
            // never overwrite — add a numeric suffix
            String base = fileName.substring(0, fileName.lastIndexOf('.'));
            String ext = fileName.substring(fileName.lastIndexOf('.'));
            int n = 1;
            while (out.exists() && n < 1000) {
                out = new File(dir, base + " (" + n + ")" + ext);
                n++;
            }
        }

        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(bytes);
            fos.flush();
        }

        MediaScannerConnection.scanFile(getContext(),
                new String[]{out.getAbsolutePath()},
                new String[]{"application/pdf"},
                null);

        return out.getAbsolutePath();
    }
}
