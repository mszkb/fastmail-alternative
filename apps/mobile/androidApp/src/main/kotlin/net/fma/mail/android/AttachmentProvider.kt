package net.fma.mail.android

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import kotlinx.coroutines.launch
import net.fma.mail.api.FmaApi
import java.io.IOException

/**
 * Hands an attachment to a viewer app (#149) without storing it: the file
 * is streamed from the instance through a pipe. Not exported; the viewer
 * gets a one-off read grant for the URI.
 * URI: content://net.fma.mail.attachments/<messageId>/<index>/<contentType b64>/<filename>
 */
class AttachmentProvider : ContentProvider() {
    override fun onCreate() = true

    private data class Ref(val messageId: String, val index: Int, val contentType: String, val filename: String)

    private fun parse(uri: Uri): Ref? {
        val segments = uri.pathSegments
        if (segments.size < 4) return null
        val type = runCatching { String(android.util.Base64.decode(segments[2], android.util.Base64.URL_SAFE)) }.getOrNull() ?: return null
        val index = segments[1].toIntOrNull() ?: return null
        return Ref(segments[0], index, type, segments[3])
    }

    override fun getType(uri: Uri): String? = parse(uri)?.contentType

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? {
        val ref = parse(uri) ?: return null
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns, 1).apply {
            addRow(columns.map { if (it == OpenableColumns.DISPLAY_NAME) ref.filename else null }.toTypedArray())
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("read only")
        val ref = parse(uri) ?: throw IOException("invalid attachment uri")
        val context = context ?: throw IOException("no context")
        val session = SecureSessionStore.get(context).load() ?: throw IOException("not logged in")
        val (read, write) = ParcelFileDescriptor.createReliablePipe()
        (context.applicationContext as FmaApplication).scope.launch {
            val api = FmaApi(session.baseUrl, { session.token })
            ParcelFileDescriptor.AutoCloseOutputStream(write).use { out ->
                try {
                    api.downloadAttachment(ref.messageId, ref.index) { bytes, length -> out.write(bytes, 0, length) }
                } catch (e: Exception) {
                    // Only the error class; never the file name (principle 6).
                    runCatching { write.closeWithError("download failed: ${e::class.simpleName}") }
                } finally {
                    api.close()
                }
            }
        }
        return read
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0

    companion object {
        const val AUTHORITY = "net.fma.mail.attachments"

        fun uri(messageId: String, index: Int, contentType: String, filename: String): Uri {
            val type = android.util.Base64.encodeToString(contentType.toByteArray(), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
            val name = filename.ifBlank { "anhang" }.replace('/', '_')
            return Uri.Builder().scheme("content").authority(AUTHORITY)
                .appendPath(messageId).appendPath(index.toString()).appendPath(type).appendPath(name).build()
        }
    }
}
