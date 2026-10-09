package net.fma.mail.android

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Smoke test on an emulator: the app starts and the connect screen enforces HTTPS. */
@RunWith(AndroidJUnit4::class)
class LaunchSmokeTest {
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

    @Before
    fun loggedOut() {
        SecureSessionStore.get(InstrumentationRegistry.getInstrumentation().targetContext).clear()
    }

    @Test
    fun startsAndRejectsPlainHttp() {
        ActivityScenario.launch(MainActivity::class.java).use {
            assertNotNull(device.wait(Until.findObject(By.text("Adresse der Instanz")), 20_000))
            val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 5_000)
            assertNotNull(field)
            field.text = "http://mail.example.org"
            device.wait(Until.findObject(By.text("Weiter")), 5_000).click()
            assertNotNull(device.wait(Until.findObject(By.text("Nur HTTPS-Adressen sind erlaubt.")), 10_000))
        }
    }
}
