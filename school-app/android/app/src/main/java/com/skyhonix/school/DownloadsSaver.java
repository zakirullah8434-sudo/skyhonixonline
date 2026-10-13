package com.skyhonix.school;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class DownloadsSaver {

    private static final String SUB_DIR = "SkyHonix";
    private static final Pattern FILENAME_STAR =
            Pattern.compile("filename\\*\\s*=\\s*[^']*'[^']*'([^;]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern FILENAME_PLAIN =
            Pattern.compile("filename\\s*=\\s*\"?([^\";]+)\"?", Pattern.CASE_INSENSITIVE);

    private DownloadsSaver() {}

    public static String save(Context context, InputStream in, String fileName, String mimeType)
            throws IOException {
        String safeName = sanitizeFileName(fileName, mimeType);
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "application/pdf";
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return saveWithMediaStore(context, in, safeName, mimeType);
        }
        return saveLegacy(context, in, safeName, mimeType);
    }

    public static String fileNameFromDisposition(String disposition) {
        if (disposition == null || disposition.isEmpty()) {
            return null;
        }
        Matcher star = FILENAME_STAR.matcher(disposition);
        if (star.find()) {
            String value = star.group(1).trim();
            try {
                return URLDecoder.decode(value, "UTF-8");
            } catch (Exception e) {
                return value;
            }
        }
        Matcher plain = FILENAME_PLAIN.matcher(disposition);
        if (plain.find()) {
            return plain.group(1).trim();
        }
        return null;
    }

    public static String fileNameFromUrl(String url) {
        try {
            String last = Uri.parse(url).getLastPathSegment();
            if (last != null && !last.isEmpty()) {
                return URLDecoder.decode(last, "UTF-8");
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static String saveWithMediaStore(Context context, InputStream in, String fileName,
            String mimeType) throws IOException {
        ContentResolver resolver = context.getContentResolver();

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS + File.separator + SUB_DIR);

        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IOException("Could not create file in Downloads/" + SUB_DIR);
        }
        try {
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) {
                    throw new IOException("Could not open output stream");
                }
                copy(in, out);
            }
        } catch (IOException e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        return Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR + "/" + fileName;
    }

    private static String saveLegacy(Context context, InputStream in, String fileName,
            String mimeType) throws IOException {
        File dir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                SUB_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("Could not create Downloads/" + SUB_DIR + " folder");
        }

        File out = new File(dir, fileName);
        if (out.exists()) {
            String base = fileName;
            String ext = "";
            int dot = fileName.lastIndexOf('.');
            if (dot > 0) {
                base = fileName.substring(0, dot);
                ext = fileName.substring(dot);
            }
            int n = 1;
            while (out.exists() && n < 1000) {
                out = new File(dir, base + " (" + n + ")" + ext);
                n++;
            }
        }

        try (FileOutputStream fos = new FileOutputStream(out)) {
            copy(in, fos);
        }
        MediaScannerConnection.scanFile(context,
                new String[]{out.getAbsolutePath()},
                new String[]{mimeType},
                null);
        return Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR + "/" + out.getName();
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        out.flush();
    }

    private static String sanitizeFileName(String name, String mimeType) {
        if (name != null) {
            int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
            if (slash >= 0) {
                name = name.substring(slash + 1);
            }
            name = name.replace("..", "").trim();
            name = name.replaceAll("[^A-Za-z0-9._ \\-]", "_");
            name = name.replaceFirst("^[.]+", "");
        }
        if (name == null || name.isEmpty()) {
            name = "download_" + System.currentTimeMillis();
        }
        if (name.length() > 90) {
            int dot = name.lastIndexOf('.');
            String ext = dot > 0 ? name.substring(dot) : "";
            int keep = Math.max(1, 90 - ext.length());
            name = name.substring(0, Math.min(name.length(), keep)) + ext;
        }
        if (!name.contains(".")) {
            String ext = "bin";
            if (mimeType != null) {
                String m = mimeType.split(";")[0].trim().toLowerCase();
                if (m.contains("pdf")) {
                    ext = "pdf";
                } else {
                    String fromMime = MimeTypeMap.getSingleton().getExtensionFromMimeType(m);
                    if (fromMime != null && !fromMime.isEmpty()) {
                        ext = fromMime;
                    }
                }
            }
            name = name + "." + ext;
        }
        return name;
    }
}
