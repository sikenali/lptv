#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 把 _MOTIF_WM_HINTS 的 decorations 置 0（无标题栏/边框），WM（xpra）随即去掉装饰。
 * 属性类型必须是 _MOTIF_WM_HINTS 原子，用 CARDINAL 会被部分 WM 忽略。 */
static int undecorate(Display *d, unsigned long wid) {
    Atom motif = XInternAtom(d, "_MOTIF_WM_HINTS", 0);
    unsigned long hints[5] = {2, 0, 0, 0, 0};   /* flags=DECORATIONS, decorations=NONE */
    XChangeProperty(d, wid, motif, motif, 32, PropModeReplace,
                    (unsigned char *)hints, 5);
    XSync(d, False);
    Atom actual_type = 0;
    int actual_fmt = 0;
    unsigned long nitems = 0, bytes_after = 0;
    unsigned char *ret = NULL;
    XGetWindowProperty(d, wid, motif, 0, 5, False, motif,
                       &actual_type, &actual_fmt, &nitems, &bytes_after, &ret);
    int ok = (nitems >= 5 && ret && actual_fmt == 32 && actual_type == motif
              && ((unsigned long *)ret)[2] == 0);
    fprintf(stderr, "undecorate: 0x%lx type=%lu fmt=%d nitems=%lu dec=%lu -> %s\n",
            wid, actual_type, actual_fmt, nitems,
            ret ? ((unsigned long *)ret)[2] : 0, ok ? "OK" : "FAIL");
    if (ret) XFree(ret);
    return ok ? 0 : 1;
}

/* 用法: lptv_icon undecorate <window_hex>
 *       lptv_icon <window_hex> <atom_name>   （stdin: 小端 32 位卡片二进制流） */
int main(int argc, char **argv) {
    Display *d = XOpenDisplay(NULL);
    if (!d) { fprintf(stderr, "lptv_icon: no display\n"); return 2; }
    if (argc == 3 && strcmp(argv[1], "undecorate") == 0) {
        unsigned long wid = strtoul(argv[2], NULL, 16);
        int r = undecorate(d, wid);
        XCloseDisplay(d);
        return r;
    }
    if (argc < 3) { fprintf(stderr, "usage: %s undecorate <window_hex> | %s <window_hex> <atom_name>\n", argv[0], argv[0]); return 2; }
    unsigned long wid = strtoul(argv[1], NULL, 16);
    Atom prop = XInternAtom(d, argv[2], 0);

    /* 读二进制卡片流 */
    size_t cap = 400000, n = 0;
    unsigned char *buf = malloc(cap);
    if (!buf) return 2;
    for (;;) {
        size_t k = fread(buf + n, 1, cap - n, stdin);
        n += k;
        if (k == 0) break;
        if (n == cap) { cap *= 2; buf = realloc(buf, cap); }
    }
    unsigned long ncards = n / 4;
    if (n % 4) fprintf(stderr, "lptv_icon: trailing %lu bytes ignored\n", n % 4);
    if (ncards < 2) { fprintf(stderr, "lptv_icon: too few cardinals (%lu)\n", ncards); return 2; }

    unsigned long *data = malloc(ncards * sizeof(unsigned long));
    for (unsigned long i = 0; i < ncards; i++) {
        unsigned char *p = buf + 4 * i;
        data[i] = (unsigned long)p[0] | ((unsigned long)p[1] << 8) |
                  ((unsigned long)p[2] << 16) | ((unsigned long)p[3] << 24);
    }
    fprintf(stderr, "lptv_icon: window=0x%lx atom=%s n=%lu\n", wid, argv[2], ncards);

    XChangeProperty(d, wid, prop, XA_CARDINAL, 32, PropModeReplace,
                    (unsigned char *)data, ncards);
    XSync(d, False);

    /* 自检 */
    Atom actual_type = 0;
    int actual_fmt = 0;
    unsigned long nitems = 0, bytes_after = 0;
    unsigned char *ret = NULL;
    XGetWindowProperty(d, wid, prop, 0, 12, False, XA_CARDINAL,
                       &actual_type, &actual_fmt, &nitems, &bytes_after, &ret);
    int ok = 1;
    if (nitems < 12 || ret == NULL) ok = 0;
    else if (actual_fmt != 32 || actual_type != XA_CARDINAL) ok = 0;
    else if (((unsigned long *)ret)[0] != data[0] || ((unsigned long *)ret)[1] != data[1]) ok = 0;
    fprintf(stderr, "verify: st type=%lu fmt=%d nitems=%lu after=%lu head=%lu %lu -> %s\n",
            actual_type, actual_fmt, nitems, bytes_after,
            ret ? ((unsigned long *)ret)[0] : 0, ret ? ((unsigned long *)ret)[1] : 0,
            ok ? "OK" : "FAIL");
    if (ret) XFree(ret);
    XCloseDisplay(d);
    free(data);
    free(buf);
    return ok ? 0 : 1;
}
