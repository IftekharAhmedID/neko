/*
 * V4L2 Capability Hack for v4l2loopback + GStreamer v4l2sink
 *
 * Problem: GStreamer's v4l2sink checks for V4L2_CAP_VIDEO_OUTPUT capability,
 * but v4l2loopback only advertises V4L2_CAP_VIDEO_CAPTURE.
 *
 * Solution: This LD_PRELOAD library intercepts ioctl() calls and adds
 * V4L2_CAP_VIDEO_OUTPUT to the capabilities when VIDIOC_QUERYCAP is called
 * on a v4l2loopback device.
 *
 * Build: gcc -shared -fPIC -o libv4l2_cap_hack.so v4l2_cap_hack.c -ldl
 * Usage: LD_PRELOAD=/path/to/libv4l2_cap_hack.so gst-launch-1.0 ... v4l2sink ...
 *
 * Author: Translucid Project
 * Date: December 2024
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <sys/ioctl.h>
#include <linux/videodev2.h>
#include <string.h>
#include <stdio.h>

/* Original ioctl function pointer */
static int (*real_ioctl)(int fd, unsigned long request, ...) = NULL;

/* Initialize the real ioctl pointer */
static void init_real_ioctl(void) {
    if (!real_ioctl) {
        real_ioctl = dlsym(RTLD_NEXT, "ioctl");
    }
}

/* Intercepted ioctl function */
int ioctl(int fd, unsigned long request, ...) {
    va_list args;
    void *arg;
    int ret;

    init_real_ioctl();

    va_start(args, request);
    arg = va_arg(args, void *);
    va_end(args);

    /* Call the real ioctl */
    ret = real_ioctl(fd, request, arg);

    /* If this is VIDIOC_QUERYCAP and it succeeded, add VIDEO_OUTPUT capability */
    if (ret == 0 && request == VIDIOC_QUERYCAP) {
        struct v4l2_capability *cap = (struct v4l2_capability *)arg;

        /* Check if this looks like a v4l2loopback device */
        /* v4l2loopback devices have "Loopback" or "NekoCam" in the card name */
        if (strstr((char *)cap->card, "Loopback") != NULL ||
            strstr((char *)cap->card, "NekoCam") != NULL ||
            strstr((char *)cap->card, "loopback") != NULL) {

            /* Add VIDEO_OUTPUT capability */
            cap->capabilities |= V4L2_CAP_VIDEO_OUTPUT;
            cap->device_caps |= V4L2_CAP_VIDEO_OUTPUT;

            /* Debug output (optional, remove in production) */
            /* fprintf(stderr, "[v4l2_cap_hack] Added VIDEO_OUTPUT to %s\n", cap->card); */
        }
    }

    return ret;
}
