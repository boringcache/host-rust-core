import org.gradle.api.Project

private const val DefaultVersionName = "1.0.0"
private const val DefaultVersionCode = 28

/**
 * The marketing version, with the commit appended when one is supplied.
 *
 * A preview build has to be able to name the commit it came from, or a
 * reviewer cannot tell it apart from a cached artifact. Released builds set
 * nothing and keep the bare version.
 */
fun Project.computeVersionName(): String {
    val commit = System.getenv("TRUAPI_COMMIT")?.takeIf { it.isNotBlank() }
    return if (commit == null) DefaultVersionName else "$DefaultVersionName+$commit"
}
fun Project.computeVersionCode(): Int = System.getenv("CI_BUILD_ID")?.toIntOrNull() ?: DefaultVersionCode
