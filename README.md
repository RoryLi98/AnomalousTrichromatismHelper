# AnomalousTrichromatismHelper · 色觉助手 Color Vision Helper

一个给色弱 / 色盲用户用的手机 Web App（PWA）：打开摄像头，准星对准哪里就读出哪里的颜色，并勾出同色色块的轮廓；“矫正”模式在 GPU 上实时处理视频，让色弱用户看到的颜色尽量接近正常色觉。

A mobile web app (PWA) for people with color-vision deficiency (CVD): point the reticle at anything to get its color name and an outline of the color region, or switch to Correct mode to see the camera feed recolored in real time.

- 中文 / English 一键切换
- 全部在手机本地处理，视频不上传
- Android（Chrome / Edge / 三星浏览器）和 iPhone（Safari，iOS 15+）都能用，可“添加到主屏幕”像 App 一样全屏打开

## 功能

| 功能 | 说明 |
| --- | --- |
| 实时识色 | 屏幕中央小十字准星，取准星处 16×16 像素块的中值并做时间平滑，避免数字跳动 |
| 两套颜色组 | **基础**：红、橙、黄、绿、青、蓝、紫、粉、棕、白、灰、黑 12 色。**精细**：150+ 中英文颜色名（如“橄榄绿 / Olive green”），再加一句系统描述（如“深黄绿色 / dark yellow-green”“偏蓝的灰色 / bluish gray”）和所属色系 |
| 色块分割 | 从准星点做区域生长，画出白色描边的平滑轮廓；可选“暗化色块以外区域”；容差可调 |
| 终极模式：实时矫正 | 红色弱 / 绿色弱 / 蓝色弱 + 程度 0–100%；方法：自动、补偿、误差转移（Daltonize）、对比增强、模拟色弱；分屏对比（可拖动分隔线）、“以色弱视角预览”（给正常色觉的人验证效果） |
| 快速自测 | 约 1 分钟的圆环点阵测试，估计色弱类型和程度，一键应用到矫正（手机屏幕未校色，结果仅供参考） |
| 其他 | 冻结画面、从相册选图、前后摄像头切换、补光灯、双指缩放、点击移动准星 / 双击回中、语音朗读颜色名、白平衡校准（对准白纸）、点击 HEX 复制 |

## 在手机上使用

摄像头只能在 **HTTPS** 页面里打开，所以需要把 `docs/` 部署到一个 https 地址。最简单的是 GitHub Pages：

1. 把仓库推送到 GitHub（`git add docs tests package.json README.md .gitignore && git commit && git push`）。
2. 在 GitHub 仓库页面 → **Settings → Pages** → Build and deployment 选 **Deploy from a branch**，Branch 选 `main`，文件夹选 **`/docs`**，保存。这个项目仓库里**不要**再填 Custom domain：用户主页仓库已经绑定了 `ruilin.li`，项目页面会自动挂在它下面。
3. 约 1 分钟后用手机打开 **https://ruilin.li/AnomalousTrichromatismHelper/**，允许摄像头权限。
4. 想像 App 一样使用：Android Chrome 菜单 →“添加到主屏幕 / 安装应用”；iPhone Safari 分享按钮 →“添加到主屏幕”。

> 仓库设为 private 时，GitHub Pages 需要 GitHub Pro / Team / Enterprise（学生可通过 GitHub Student Developer Pack 免费获得 Pro）。即使仓库是私有的，Pages 网站本身仍然是公开可访问的，只有源码不公开。

（也可以把 `docs/` 文件夹拖到 Netlify Drop 等任意静态托管服务，只要是 https 即可。）

### 怎么用

- **识色**：把准星对准物体。顶部切换“识色 / 矫正”，卡片右下角切换“基础 / 精细”颜色组，喇叭按钮朗读。点画面任意位置移动准星，双击回到中心。
- **矫正**：先点“快速自测”或手动选择类型和程度。色弱（程度 < 95%）用“补偿”效果最自然；红绿色盲（≈100%）用“误差转移”或“对比增强”。打开“分屏对比”可以左右对照原图和处理后的画面。点一下画面可以收起面板。
- 灯光偏色严重时：设置 → 白平衡校准，准星对准白纸后点“校准”。

## 算法

参考了 `论文资料/` 里的文献，并换成了更新的颜色模型：

- **颜色空间**：sRGB → 线性 RGB → OKLab / OKLCH（Ottosson 2020，感知均匀，计算便宜，适合在手机上每帧处理）和 CIELAB（D65）。
- **基础色命名**：在 OKLCH 上按色相角、明度、彩度划分 12 类（棕色 = 暗的橙/黄色，粉色 = 亮的红/玫红色等），阈值相对于每个色相的 sRGB 色域顶点（cusp）计算。
- **精细色命名**：CIEDE2000 色差找最近的命名颜色；色差 > 12 时名字前加“≈”。系统描述由色相（15 段）+ 明度/彩度修饰词组合生成。
- **色块分割**：参考何志良等《基于图像分割的局部色盲矫正方法》用 Lab 色度做分割的思路：降采样（约 8 万像素）→ OKLab → 3×3 均值滤波 → 从准星做 4 邻域区域生长（彩色种子时亮度权重降到 0.3，减少阴影/高光影响；中性色种子保留亮度）→ 形态学闭运算 + 小孔洞填充 → 时间平滑 → Marching Squares 提取亚像素轮廓。
- **色弱模拟**：Machado, Oliveira & Fernandes (2009) 生理模型，程度 0–1 按 0.1 间隔插值，作用于线性 RGB。
- **补偿（色弱）**：Ro & Yang (2004)《Color adaptation for anomalous trichromats》的逆变换 `A = T_abnormal⁻¹ · T_normal · c`，即对模拟矩阵求逆，使 `M·A = c`。屏幕显示不出的颜色按像素朝自身亮度的灰色收缩（保持色相的色域映射），所以色弱者看到的是 **色相正确、饱和度略低** 的颜色。红/绿色弱在程度 100% 时矩阵奇异，此时“自动”改用误差转移；蓝色弱模型始终可逆。
- **误差转移（Daltonize）**：Fidaner 等的误差重分配：`err = c − sim(c)`，把看不到的误差加到可见通道。
- **对比增强**：在 OKLab 中把丢失的对立轴（红绿 a 或蓝黄 b）叠加到可见轴和亮度上，区分度最高但颜色变化明显。
- **快速自测**：类似 Cambridge Colour Test 的点阵 Landolt C，亮度随机抖动以排除亮度线索；三个刺激方向取 Machado 红/绿/蓝全色盲矩阵的最小奇异向量（各自最难看出的颜色方向），2-down/1-up 阶梯法分别求阈值。判定时做联合拟合：对每个假设（类型, 程度），在阈值处模型预测的感知色差应在三个方向上相等，取 log ΔE 方差最小的假设；个人的检测灵敏度（与屏幕、环境光有关）作为自由参数一起拟合，所以不依赖屏幕校色。用模拟观察者验证：正常→正常，绿色弱 80%→75–85%，红色弱 70%→70%，蓝色盲→85–95%。
- **渲染**：WebGL 1.0 片元着色器逐像素处理（兼容老 iPhone），分析时只把降采样后的小图从 GPU 读回 CPU。

单元测试验证了 CIEDE2000（Sharma 2005 参考数据）、命名、Machado 矩阵、补偿后色相保持与红绿区分度提升（如绿色弱 50%：区分度 ΔE 19 → 37）、分割面积与孔洞填充、自测单调性。

## 本地开发与测试

```bash
npm start                 # http://localhost:8765 （localhost 允许摄像头）
npm test                  # 单元测试（Node 18+）
npm run test:e2e          # 端到端：合成摄像头视频 + Playwright Chromium（需 numpy、Pillow、ffmpeg、playwright）
```

文件结构：

```
docs/                 ← 网站根目录（GitHub Pages 从这里发布）
  index.html  manifest.webmanifest  sw.js（离线缓存）  icons/
  css/style.css
  js/main.js       界面与主循环          js/gl.js        WebGL 渲染与矫正着色器
  js/color.js      颜色空间与 CIEDE2000  js/naming.js    基础/精细颜色命名
  js/cvd.js        模拟/补偿/Daltonize   js/machado.js   Machado 2009 矩阵
  js/segment.js    区域生长 + 轮廓       js/selftest.js  快速自测
  js/camera.js     摄像头/补光           js/i18n.js      中英文文案
tests/  unit.test.mjs  e2e.py  make_scene.py
```

## 局限

- 手机摄像头的自动白平衡和曝光会改变颜色，强烈的彩色灯光下请先做白平衡校准；颜色名是“屏幕上这块像素”的颜色，不是物体在标准光源下的颜色。
- 补偿模式受屏幕色域限制：程度越高，能还原的饱和度越低（色相仍然正确）。
- 快速自测在未校色的手机屏幕上只是粗略估计，不能替代医院的色觉检查（如 Ishihara、FM-100、色觉镜）。

---

## 研究笔记（原 README）

Help anomalous trichromatism to pass the test
考虑算法所使用的颜色空间  
学习不同色弱/色盲的分辨力区别
考虑帮助色弱/色盲分辨观看图像的UI设计
考虑Mobile端分析颜色RGB模式及色盲模式的算法设计
考虑Mobile端的UI设计  

Desktop端实现思路：Python + OpenCV
Mobile端实现思路：Android studio + OpenCV-Android-SDK (Java!!!)
先从调用手机摄像头开始，后熟悉OpenCV-Android-SDK的Sample
先从色盲/色弱的理论知识先准备。 

A New Color Blindness Cure Model Based on BP Neural Network
Visual contents adaptation for colour vision deficiency
A fixed transformation of color images for dichromats based on similarity matrices

准备知识：
LSM颜色空间
人眼LSM视锥细胞
原理：颜色空间几何变换映射

图像处理四种矫正色盲的算法：
自适应的矫正算法
旋转H分量的矫正算法
几何变换的矫正算法
角度自适应的矫正算法


1．按使用类别分类

彩色色度学模型：CIE-RGB、CIE-XYZ、均匀色差彩色模型（CIE 1976Luv和CIE Lab）

工业彩色模型：RGB彩色显示模型、CMYK彩色印制模型、彩色传输模型YUV（PAL）、YIQ（NTSC）、YCrCb（数字高清晰度电视）

视觉彩色模型：HVC（孟赛尔）、HSB（Photoshop）、HLS（Windows画图和Apple Color Picker）、HSI（图像分割）、HSY（电视）、Ohta（图像分割）等。

2．按颜色感知分类

混合颜色模型：按3种基色的比例混合而成的颜色。RGB、CMYK、XYZ等

非线形亮度/色度颜色模型：用一个分量表示非色彩的感知，用两个分量表示色彩的感知，这两个分量都是色差属性。L*a*b、L*u*v、YUV、YIQ等。

强度/饱和度/色调模型：用强度描述亮度或灰度等光强的感知，用饱和度和色调描述色彩的感知，这两个分量接近人眼对颜色的感觉。如HIS、HSL、HSV、LCH等


1.全色盲
全色盲是色盲中最为严重的，也是极为少见的一种色盲，属于完全性视锥细胞功能障碍（三种锥细胞缺失），与夜盲（视杆细胞功能障碍）恰好相反，患者尤喜暗、畏光，表现为昼盲。
全色盲不能识别颜色，只能感知亮度信息，七彩世界在其眼中是一片灰暗，如同观黑白电视一般仅有明暗之分，而无颜色差别。
而且所见红色发暗、蓝色光亮、此外还有视力差、弱视、中心性暗点、摆动性眼球震颤等症状。

2.红二色盲
又称第一色盲，是由于L锥细胞的缺失造成的。患者主要是不能分辨红色。对(红色与深绿色)、(蓝色与紫红色以及紫色)不能分辨。
常把(绿色视为黄色)，(紫色看成蓝色)，将((绿色和蓝色相混)为白色)。

3.绿二色盲
又称第二色盲，是由于M锥细胞的缺失造成的。患者不能分辨(淡绿色与深红色)、(紫色与青蓝色)、(紫红色与灰色)，把(绿色视为灰色或暗黑色)。
临床上把红二色盲与绿二色盲统称为红绿色盲，患者较常见,平常说的色育一般就是指红绿色盲。

4.蓝二色盲
又称第三色盲，是由于S锥细胞的缺失造成的。患者(蓝黄色混淆不清），对红、绿色可辨，较少见。

5.全色反
又称三原色盲，也是所有色盲病中较严重的一种视觉障碍。现实世界在其眼睛中如同一幅底片，患者将(红色视为绿色)，(黑色视为白色Z)，所有看到的颜色与现实完全相反。

5.色弱
色弱又叫三色觉异常，是色盲中最轻的一种，患者一般感知不到自己有色觉问题，只有通过专业的色觉测试才能发现。
三色觉异常是三种锥细胞的一种变异造成的，其中L锥细胞的变异对应红色弱，M锥细胞的变异对应绿色弱，S锥细胞的变异对应蓝色弱。
色弱表现为对部分颜色区分力的降低，红色弱和绿色弱对颜色的区分能力相近，都是对红、绿颜色的区分能力下降，而蓝色弱是对蓝、绿颜色的区分能力下降。

色盲矫正镜的原理：是根据补色拓扑学原理，在镜片土进行特殊镀膜，产生截止波长的作用。
对长波长者可透射，对短波长者发生反射。色盲患者戴上色盲眼镜，可在一定程度上使原来辨认不清的图案变为能正确辨认，达到矫正色觉障碍的效果。
实际上，这种方式只是对色彩进行简单的滤除，并不能达到很好矫正的目的。


#include <opencv2\opencv.hpp>
#include <iostream>

using namespace std;
using namespace cv;

Mat RGB2LAlphBeta(Mat3b &src)
{
    Mat3f L_AlphBeta(src.rows, src.cols);
    //cvtColor(src,dest,CV_BGR2XYZ);
    float X, Y, Z, L, M, S, _L, Alph, Beta;
    int R, G, B;
    for (int i = 0; i < src.rows; i++)
    {
        for (int j = 0; j < src.cols; j++)
        {
            B = src(i, j)[0];
            G = src(i, j)[1];
            R = src(i, j)[2];
            
            X = (0.4124 * R) + (0.3576 * G) + (0.1805 * B);
            Y = (0.2126 * R) + (0.7152 * G) + (0.0722 * B);
            Z = (0.0193 * R) + (0.1192 * G) + (0.9505 * B);
            L = (0.3897 * X) + (0.6890 * Y) + (-0.0787 * Z);
            M = (-0.2298 * X) + (1.1834* Y) + (0.0464 * Z);
            S = (0.0000 * X) + (0.0000 * Y) + (1.0000 * Z);

            //for handling log
            if (L == 0.0000) L = 1.0000;
            if (M == 0.0000) M = 1.0000;
            if (S == 0.0000) S = 1.0000;


            //LMS to Lab
            _L = (1.0 / sqrt(3.0)) *((1.0000 * log10(L)) + (1.0000 * log10(M)) + (1.0000 * log10(S)));
            Alph = (1.0 / sqrt(6.0)) * ((1.0000 * log10(L)) + (1.0000 * log10(M)) + (-2.0000 * log10(S)));
            Beta = (1.0 / sqrt(2.0)) * ((1.0000 * log10(L)) + (-1.0000 * log10(M)) + (-0.0000 * log10(S)));

            L_AlphBeta(i, j)[0] = _L;
            L_AlphBeta(i, j)[1] = Alph;
            L_AlphBeta(i, j)[2] = Beta;
        }
    }

    return L_AlphBeta;
}

Mat LAlphBeta2RGB(Mat3f &src)
{
    Mat3f XYZ(src.rows, src.cols);
    Mat3b BGR(src.rows, src.cols);

    float X, Y, Z, L, M, S, _L, Alph, Beta;
    for (int i = 0; i < src.rows; i++)
    {
        for (int j = 0; j < src.cols; j++)
        {
            _L = src(i, j)[0] * 1.7321;
            Alph = src(i, j)[1] * 2.4495;
            Beta = src(i, j)[2] * 1.4142;

            /*Inv_Transform_logLMS2lab =

            0.33333   0.16667   0.50000
            0.33333   0.16667  -0.50000
            0.33333  -0.33333   0.00000*/
            L = (0.33333*_L) + (0.16667 * Alph) + (0.50000 * Beta);
            M = (0.33333 * _L) + (0.16667 * Alph) + (-0.50000 * Beta);
            S = (0.33333 * _L) + (-0.33333 * Alph) + (0.00000* Beta);

            L = pow(10, L);
            if (L == 1) L = 0;
            M = pow(10, M);
            if (M == 1) M = 0;
            S = pow(10, S);
            if (S == 1) S = 0;
            /*Inv_Transform_XYZ2LMS

            1.91024  -1.11218   0.20194
            0.37094   0.62905   0.00001
            0.00000   0.00000   1.00000*/

            X = (1.91024 *L) + (-1.11218 * M) + (0.20194 * S);
            Y = (0.37094 * L) + (0.62905 * M) + (0.00001 * S);
            Z = (0.00000 * L) + (0.00000 * M) + (1.00000 * S);
            /*Inv_Transform_RGB2XYZ
            3.240625  -1.537208  -0.498629
            -0.968931   1.875756   0.041518
            0.055710  -0.204021   1.056996*/

            BGR(i, j)[2] = saturate_cast<uchar>((3.240625 * X) + (-1.537208 * Y) + (-0.498629 * Z));
            BGR(i, j)[1] = saturate_cast<uchar>((-0.968931 * X) + (1.875756 * Y) + (0.041518 * Z));
            BGR(i, j)[0] = saturate_cast<uchar>((0.055710 * X) + (-0.204021 * Y) + (1.056996 * Z));
        }
    }
    //normalize(BGR,BGR, 255, 0, NORM_MINMAX, CV_8UC3 );
    return BGR;
}


int main()
{
    Mat3b img = imread("path_to_image");

    Mat3f labb = RGB2LAlphBeta(img);

    Mat3b rgb = LAlphBeta2RGB(labb);

    Mat3b diff;
    absdiff(img, rgb, diff);

    // Check if all pixels are equals
    cout << ((sum(diff) == Scalar(0, 0, 0, 0)) ? "Equals" : "Different");

    return 0;
}

https://blog.51cto.com/u_15353042/3751269

https://chaphlagical.icu/DIP/index/report1.pdf

https://arxiv.org/pdf/1711.10662.pdf

https://blog.css8.cn/post/18674723.html

https://wikichi.icu/wiki/LMS_color_space
https://wikichi.icu/wiki/chromatic_adaptation

https://yylifen.github.io/color-from-hexcodes-to-eyeballs/color/chapter/ch11.html